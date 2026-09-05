import json
import os
import re
import tempfile
from threading import Lock
from io import BytesIO
from pathlib import Path
from PIL import Image, ImageEnhance, ImageFilter
import cv2
import numpy as np

# REGEX MEJORADO: Captura el valor numérico completo incluso si está pegado a "Bs."
PRICE_NUMBER = r"(?:[0-9]{1,3}(?:[.,][0-9]{3})+(?:[.,][0-9]{1,2})?|[0-9]+(?:[.,][0-9]{1,2})?)"
PRICE_PATTERN = re.compile(rf"(?i)(?:bs|precio|pvp|oferta)\.?\s*[:.]?\s*({PRICE_NUMBER})")

# Detecta cualquier patrón de monto aislado con separadores de miles/decimales
NUMBER_PATTERN = re.compile(
    r"(?<!\d)([0-9]{1,3}(?:[.,][0-9]{3})+(?:[.,][0-9]{1,2})?|[0-9]+(?:[.,][0-9]{1,2})?)(?!\d)"
)
BARCODE_PATTERN = re.compile(r"(?<!\d)(\d{8,14})(?!\d)")

_ocr_engine = None
_ocr_lock = Lock()


def inicializar_ocr():
    """Carga el modelo una sola vez para evitar esperar durante la primera foto."""
    global _ocr_engine
    if _ocr_engine is not None:
        return
    try:
        from paddleocr import PaddleOCR
    except ImportError as error:
        raise RuntimeError("Falta PaddleOCR en el entorno Python") from error
    with _ocr_lock:
        if _ocr_engine is None:
            _ocr_engine = PaddleOCR(
                lang="es",
                text_detection_model_name="PP-OCRv5_mobile_det",
                text_recognition_model_name="PP-OCRv5_mobile_rec",
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
                enable_mkldnn=False,
            )


def normalizar_precio(value):
    """Convierte formatos 1.250,50 y 1,250.50 a un número decimal (float), descartando SKUs."""
    if not value:
        return None
    value = str(value).strip()
    
    # Descarta enteros puros de 6 o más dígitos (evita interpretar SKUs/Códigos como precios)
    if value.isdigit() and len(value) >= 6:
        return None

    # Si tiene puntos y comas (ej: 1.230,00)
    if "," in value and "." in value:
        if value.rfind(",") > value.rfind("."):
            # Formato latino/europeo: 1.230,00 -> 1230.00
            value = value.replace(".", "").replace(",", ".")
        else:
            # Formato anglosajón: 1,230.00 -> 1230.00
            value = value.replace(",", "")
    elif "," in value:
        parts = value.split(",")
        if len(parts[-1]) <= 2:
            value = "".join(parts[:-1]) + "." + parts[-1]
        else:
            value = "".join(parts)
    elif value.count(".") > 1:
        value = value.replace(".", "")

    try:
        val = float(value)
        # Umbral de cordura para evitar valores gigantes colados por números internos
        if val > 500000:
            return None
        return val
    except ValueError:
        return None


def extraer_precio(text):
    """Busca primero importes cercanos a palabras clave y devuelve el mayor valor válido."""
    contextual = PRICE_PATTERN.findall(text)
    candidates = contextual or NUMBER_PATTERN.findall(text)
    
    prices = []
    for raw in candidates:
        price = normalizar_precio(raw)
        if price is not None and price > 0:
            prices.append((raw, price))
            
    if not prices:
        return None
        
    # Devuelve el precio de mayor valor si hay múltiples coincidencias
    raw, price = max(prices, key=lambda item: item[1])
    return {"precio_detectado": price, "valor_leido": raw}


def extraer_precios(text):
    """Devuelve todos los importes distintos encontrados en la lectura."""
    candidates = PRICE_PATTERN.findall(text) or NUMBER_PATTERN.findall(text)
    prices = []
    seen = set()
    for raw in candidates:
        price = normalizar_precio(raw)
        if price is not None and price > 0 and price not in seen:
            prices.append({"precio": price, "valor_leido": raw})
            seen.add(price)
    return prices


def extraer_codigos_barras(text):
    return list(dict.fromkeys(BARCODE_PATTERN.findall(text)))


def _resultado_a_texto(result):
    if isinstance(result, dict):
        payload = result
    else:
        payload = getattr(result, "json", None)
        if callable(payload):
            payload = payload()
    if isinstance(payload, str):
        payload = json.loads(payload)
    if isinstance(payload, dict):
        payload = payload.get("res", payload)
        texts = payload.get("rec_texts", [])
        scores = payload.get("rec_scores", [])
        return " ".join(str(text) for text in texts), [float(score) for score in scores], [str(text) for text in texts]
    return "", [], []


def detectar_y_recortar_etiquetas(image_bytes: bytes):
    """
    Detecta rectángulos con proporciones típicas de etiquetas de precio en una foto
    y retorna una lista de imágenes recortadas en formato bytes.
    """
    nparr = np.frombuffer(image_bytes, np.uint8)
    img_cv = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    
    if img_cv is None:
        return []

    alto_total, ancho_total = img_cv.shape[:2]
    
    # Convertir a escala de grises y desenfocar
    gray = cv2.cvtColor(img_cv, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    
    # Umbralizado adaptativo para resaltar etiquetas claras
    thresh = cv2.adaptiveThreshold(
        blur, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 11, 2
    )

    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    recortes_bytes = []

    for cnt in contours:
        x, y, w, h = cv2.boundingRect(cnt)
        aspect_ratio = float(w) / h
        
        # Filtros de tamaño y aspecto para aislarlas de bordes/fondos
        min_ancho = int(ancho_total * 0.08)
        max_ancho = int(ancho_total * 0.45)
        min_alto = int(alto_total * 0.03)

        if min_ancho < w < max_ancho and h > min_alto and 1.2 <= aspect_ratio <= 4.5:
            pad = 5
            x1 = max(0, x - pad)
            y1 = max(0, y - pad)
            x2 = min(ancho_total, x + w + pad)
            y2 = min(alto_total, y + h + pad)
            
            crop = img_cv[y1:y2, x1:x2]
            crop_rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
            pil_crop = Image.fromarray(crop_rgb)
            
            buffer = BytesIO()
            pil_crop.save(buffer, format="JPEG", quality=85)
            recortes_bytes.append(buffer.getvalue())

    return recortes_bytes


def reconocer_precio(image_bytes, filename="captura.jpg"):
    """Ejecuta PaddleOCR sobre una imagen y devuelve precio, texto y confianza."""
    global _ocr_engine
    try:
        os.environ.setdefault("FLAGS_use_mkldnn", "0")
        from paddleocr import PaddleOCR
    except ImportError as error:
        raise RuntimeError("Falta Pillow o PaddleOCR en el entorno Python") from error

    try:
        image = Image.open(BytesIO(image_bytes))
        image.load()
        
        # Redimensión proporcional máxima a 1024px para cuidar la RAM
        image.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
        image = ImageEnhance.Contrast(image.convert("RGB")).enhance(1.35)
        image = image.filter(ImageFilter.SHARPEN)
        
        normalized = BytesIO()
        image.save(normalized, format="JPEG", quality=75, optimize=True)
        image_bytes = normalized.getvalue()
    except Exception as error:
        raise ValueError("La imagen está dañada o tiene un formato no compatible") from error

    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as temporary_file:
        temporary_file.write(image_bytes)
        image_path = temporary_file.name

    try:
        inicializar_ocr()
        with _ocr_lock:
            results = _ocr_engine.predict(image_path)
            
        texts = []
        scores = []
        lines = []
        for result in results:
            result_text, result_scores, result_lines = _resultado_a_texto(result)
            texts.append(result_text)
            scores.extend(result_scores)
            lines.extend(result_lines)
            
        full_text = " ".join(texts).strip()
        extracted = extraer_precio(full_text)
        all_prices = extraer_precios(full_text)
        
        if extracted is None:
            return {
                "precio_detectado": None,
                "valor_leido": None,
                "precios_detectados": all_prices,
                "texto": full_text,
                "confianza": 0,
                "codigos_barras": extraer_codigos_barras(full_text),
                "lineas": lines,
            }
            
        return {
            **extracted,
            "precios_detectados": all_prices,
            "texto": full_text,
            "confianza": round(sum(scores) / len(scores), 3) if scores else 0,
            "codigos_barras": extraer_codigos_barras(full_text),
            "lineas": lines,
        }
    finally:
        Path(image_path).unlink(missing_ok=True)


def auditar_anaquel_completo(image_bytes: bytes, filename="anaquel.jpg"):
    """
    Extrae y procesa individualmente las etiquetas de un anaquel panorámico.
    Si no halla recortes específicos, realiza un fallback al análisis directo.
    """
    recortes = detectar_y_recortar_etiquetas(image_bytes)
    
    if not recortes:
        return [reconocer_precio(image_bytes, filename)]

    resultados = []
    for idx, crop_bytes in enumerate(recortes):
        res = reconocer_precio(crop_bytes, filename=f"crop_{idx}.jpg")
        if res.get("precio_detectado") or res.get("precios_detectados"):
            resultados.append(res)
            
    return resultados if resultados else [reconocer_precio(image_bytes, filename)]