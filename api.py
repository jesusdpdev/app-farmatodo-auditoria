import asyncio
from difflib import SequenceMatcher
import re
import unicodedata
from contextlib import asynccontextmanager
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from mysql.connector import Error as MySQLError

from audit_service import buscar_productos_farmatodo, obtener_producto_farmatodo
from database import get_connection
# IMPORTANTE: Importar auditar_anaquel_completo
from ocr_service import (
    auditar_anaquel_completo,
    extraer_precios,
    inicializar_ocr,
    reconocer_precio,
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await asyncio.to_thread(inicializar_ocr)
    yield


app = FastAPI(title="API de auditoria de precios", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def is_image_upload(file: UploadFile) -> bool:
    content_type = file.content_type or ""
    return content_type.startswith("image/") or Path(file.filename or "").suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}


def is_raw_image(request: Request, filename: str) -> bool:
    content_type = request.headers.get("content-type", "").split(";", 1)[0].lower()
    return content_type.startswith("image/") or Path(filename).suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}


def json_value(value):
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    return value


@app.get("/health")
def health():
    connection = get_connection()
    if connection is None:
        return {"ok": True, "database": False}
    connection.close()
    return {"ok": True, "database": True}


@app.get("/productos")
def list_products():
    connection = get_connection()
    if connection is None:
        return []

    cursor = None
    try:
        cursor = connection.cursor(dictionary=True)
        cursor.execute(
            """
            SELECT sku, codigo_barras, nombre, precio_oficial, estado, actualizado_en
            FROM productos
            ORDER BY actualizado_en DESC, nombre ASC
            """
        )
        products = cursor.fetchall()
        latest_products = {}
        for product in products:
            sku = str(product.get("sku") or product.get("codigo_barras") or product.get("nombre"))
            latest_products.setdefault(sku, product)
        return [{key: json_value(value) for key, value in product.items()} for product in latest_products.values()]
    except MySQLError as error:
        return []
    finally:
        if cursor is not None:
            cursor.close()
        connection.close()


@app.post("/productos/actualizar/{sku}")
async def update_product(sku: str):
    product = await asyncio.to_thread(obtener_producto_farmatodo, sku)
    if product is None:
        raise HTTPException(status_code=502, detail="No se pudo consultar el producto en Farmatodo")
    return product


def build_comparison(result, product):
    official_price = None if product is None else json_value(product.get("precio") if product.get("precio") is not None else product.get("precio_oficial"))
    detected_price = result.get("precio_detectado")
    return {
        **result,
        "sku": None if product is None else product.get("sku"),
        "codigos_barras_producto": None if product is None else product.get("codigos_barras") or product.get("codigo_barras"),
        "nombre": None if product is None else product.get("nombre"),
        "imagen": None if product is None else product.get("imagen"),
        "precio_oficial": official_price,
        "estado": "coincide" if official_price is not None and detected_price is not None and float(official_price) == float(detected_price) else "cambiar" if official_price is not None and detected_price is not None else "sin_precio_detectado",
        "coincide": official_price is not None and detected_price is not None and float(official_price) == float(detected_price),
        "diferencia": None if official_price is None or detected_price is None else round(float(detected_price) - float(official_price), 2),
        "fuente_precio_oficial": "Farmatodo" if official_price is not None else None,
    }


def compare_shelf_prices(result, products):
    lines = result.get("lineas") or [result.get("texto", "")]
    detected_prices = result.get("precios_detectados", [])
    used_products = set()
    comparisons = []

    for index, detected in enumerate(detected_prices):
        price_line_index = next((line_index for line_index, line in enumerate(lines) if any(item["precio"] == detected["precio"] for item in extraer_precios(line))), index)
        evidence = " ".join(lines[max(0, price_line_index - 2):price_line_index + 3])
        evidence_tokens = meaningful_product_tokens(evidence)
        evidence_barcodes = set(re.findall(r"(?<!\d)\d{8,14}(?!\d)", evidence))
        ranked = []
        for product in products:
            product_codes = product.get("codigos_barras") or product.get("codigo_barras") or []
            if isinstance(product_codes, (str, int)):
                product_codes = [product_codes]
            name_tokens = meaningful_product_tokens(product.get("nombre", ""))
            overlap = name_tokens & evidence_tokens
            fuzzy_match = any(
                SequenceMatcher(None, product_token, evidence_token).ratio() >= 0.72
                for product_token in name_tokens
                for evidence_token in evidence_tokens
                if len(product_token) >= 5 and len(evidence_token) >= 5
            )
            barcode_match = bool(evidence_barcodes & {str(code) for code in product_codes})
            score = len(overlap) + (2 if fuzzy_match else 0) + (10 if barcode_match else 0)
            strong_name_match = any(len(token) >= 6 for token in overlap)
            if barcode_match or strong_name_match or len(overlap) >= 2 or fuzzy_match:
                ranked.append((score, product))
        ranked.sort(key=lambda item: item[0], reverse=True)
        available = [item for item in ranked if str(item[1].get("sku")) not in used_products]
        product = (available or ranked)[0][1] if ranked else None
        if product:
            used_products.add(str(product.get("sku")))
        official_price = json_value(product.get("precio") if product and product.get("precio") is not None else product.get("precio_oficial") if product else None)
        shelf_price = detected["precio"]
        coincide = product is not None and official_price is not None and float(shelf_price) == float(official_price)
        comparisons.append({
            **detected,
            "sku": product.get("sku") if product else None,
            "codigos_barras_producto": product.get("codigos_barras") or product.get("codigo_barras") if product else None,
            "nombre": product.get("nombre") if product else None,
            "imagen": product.get("imagen") if product else None,
            "precio_oficial": official_price,
            "estado": "coincide" if coincide else "cambiar" if product and official_price is not None else "sin_identificar",
            "coincide": coincide,
            "diferencia": None if official_price is None else round(float(shelf_price) - float(official_price), 2),
            "identificado_por": "sku_o_codigo" if product and (product.get("sku") or product.get("codigo_barras")) else "nombre_ocr",
        })

    return {
        **result,
        "comparaciones": comparisons,
        "para_cambiar": [comparison for comparison in comparisons if comparison["estado"] == "cambiar"],
        "productos_identificados": sum(1 for comparison in comparisons if comparison.get("sku")),
    }


def normalize_product_text(value):
    plain_text = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9 ]", " ", plain_text.lower())


GENERIC_PRODUCT_WORDS = {"para", "con", "por", "del", "las", "los", "una", "uno", "caja", "und", "x", "mg", "ml", "gr", "g"}


def meaningful_product_tokens(value):
    return {
        token for token in normalize_product_text(value).split()
        if len(token) >= 4 and token not in GENERIC_PRODUCT_WORDS and not token.isdigit()
    }


async def get_farmatodo_products(skus):
    if not skus:
        return []
    products = await asyncio.gather(*(asyncio.to_thread(obtener_producto_farmatodo, sku) for sku in skus))
    return [product for product in products if product is not None]


async def get_products_for_shelf(skus, ocr_text, lines=None):
    if skus:
        return await get_farmatodo_products(skus)
    source_lines = lines or [ocr_text]
    price_indexes = [index for index, line in enumerate(source_lines) if extraer_precios(line)]
    queries = [" ".join(source_lines[max(0, index - 2):index + 3]) for index in price_indexes] or [ocr_text]
    search_requests = []
    seen_queries = set()
    for line in queries:
        query = re.sub(r"\b(?:bs|pvp|precio|oferta)?\s*[0-9][0-9.,]*\b", " ", line, flags=re.IGNORECASE).strip()
        words = list(meaningful_product_tokens(query))
        query_key = " ".join(words[:6])
        if query_key and query_key not in seen_queries:
            seen_queries.add(query_key)
            search_requests.append(asyncio.to_thread(buscar_productos_farmatodo, query_key, 5))
        for barcode in re.findall(r"(?<!\d)\d{8,14}(?!\d)", line):
            if barcode not in seen_queries:
                seen_queries.add(barcode)
                search_requests.append(asyncio.to_thread(buscar_productos_farmatodo, barcode, 3))
    candidates = [product for group in await asyncio.gather(*search_requests) for product in group] if search_requests else []
    unique = {}
    for product in candidates:
        unique[str(product.get("sku"))] = product
    return list(unique.values())


# ==========================================
# ENDPOINTS PARA UNA SOLA ETIQUETA
# ==========================================

@app.post("/ocr")
async def read_price_from_image(file: UploadFile = File(...), sku: str | None = None):
    if not is_image_upload(file):
        raise HTTPException(status_code=415, detail="El archivo debe ser una imagen")
    image_bytes = await file.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="La imagen esta vacia")
    try:
        result = await asyncio.to_thread(reconocer_precio, image_bytes, file.filename or "captura.jpg")
        product = await asyncio.to_thread(obtener_producto_farmatodo, sku) if sku else None
        return build_comparison(result, product)
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=415, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Error procesando la imagen: {error}") from error


@app.post("/ocr/raw")
async def read_price_from_raw_image(request: Request, filename: str = "captura.jpg", sku: str | None = None):
    """(Mantiene uso para 1 etiqueta en bytes directos)"""
    if not is_raw_image(request, filename):
        raise HTTPException(status_code=415, detail="El archivo debe ser una imagen JPG, PNG o WEBP")
    image_bytes = await request.body()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="La imagen esta vacia")
    try:
        result = await asyncio.to_thread(reconocer_precio, image_bytes, filename)
        product = await asyncio.to_thread(obtener_producto_farmatodo, sku) if sku else None
        return build_comparison(result, product)
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=415, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Error procesando la imagen: {error}") from error


# ==========================================
# ENDPOINTS PARA ANAQUEL COMPLETO (OPENCV)
# ==========================================

@app.post("/ocr/anaquel")
async def read_shelf_prices(file: UploadFile = File(...), skus: str | None = None):
    if not is_image_upload(file):
        raise HTTPException(status_code=415, detail="El archivo debe ser una imagen")
    image_bytes = await file.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="La imagen esta vacia")
    try:
        results = await asyncio.to_thread(auditar_anaquel_completo, image_bytes, file.filename or "anaquel.jpg")
        
        full_text = " ".join(r.get("texto", "") for r in results)
        all_lines = [line for r in results for line in r.get("lineas", [])]
        
        products = await get_products_for_shelf([sku.strip() for sku in (skus or "").split(",") if sku.strip()], full_text, all_lines)
        
        comparaciones_totales = []
        for result in results:
            comp = compare_shelf_prices(result, products)
            comparaciones_totales.extend(comp.get("comparaciones", []))

        return {
            "total_etiquetas_detectadas": len(results),
            "comparaciones": comparaciones_totales,
            "para_cambiar": [c for c in comparaciones_totales if c.get("estado") == "cambiar"],
            "productos_identificados": sum(1 for c in comparaciones_totales if c.get("sku")),
        }
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=415, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Error procesando el anaquel: {error}") from error


@app.post("/ocr/anaquel/raw")
async def read_shelf_prices_raw(request: Request, filename: str = "anaquel.jpg", skus: str | None = None):
    if not is_raw_image(request, filename):
        raise HTTPException(status_code=415, detail="El archivo debe ser una imagen JPG, PNG o WEBP")
    image_bytes = await request.body()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="La imagen esta vacia")
    try:
        results = await asyncio.to_thread(auditar_anaquel_completo, image_bytes, filename)
        
        full_text = " ".join(r.get("texto", "") for r in results)
        all_lines = [line for r in results for line in r.get("lineas", [])]
        
        products = await get_products_for_shelf([sku.strip() for sku in (skus or "").split(",") if sku.strip()], full_text, all_lines)
        
        comparaciones_totales = []
        for result in results:
            comp = compare_shelf_prices(result, products)
            comparaciones_totales.extend(comp.get("comparaciones", []))

        return {
            "total_etiquetas_detectadas": len(results),
            "comparaciones": comparaciones_totales,
            "para_cambiar": [c for c in comparaciones_totales if c.get("estado") == "cambiar"],
            "productos_identificados": sum(1 for c in comparaciones_totales if c.get("sku")),
        }
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=415, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Error procesando el anaquel: {error}") from error


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("api:app", host="0.0.0.0", port=8000, reload=True)