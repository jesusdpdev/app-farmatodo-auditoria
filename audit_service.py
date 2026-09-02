import requests
from functools import lru_cache
from requests.adapters import HTTPAdapter


session = requests.Session()
session.headers.update({
    "User-Agent": "FarmatodoAuditoria/1.0",
    "Accept": "application/json",
})
session.mount("https://", HTTPAdapter(pool_connections=10, pool_maxsize=10))


@lru_cache(maxsize=256)
def obtener_producto_farmatodo(sku):
    """Obtiene un producto sin ejecutar consultas al importar este módulo."""
    sku = str(sku).strip()
    if not sku:
        return None
    url = f"https://api-search.farmatodo.com/1/indexes/products-venezuela/{sku}"

    try:
        response = session.get(url, timeout=(2, 5))
        response.raise_for_status()
        data = response.json()
    except (requests.exceptions.RequestException, ValueError) as error:
        print(f"[Audit service] No se pudo consultar el SKU {sku}: {error}")
        return None

    image = data.get("mediaImageUrl") or data.get("image") or data.get("imageUrl") or data.get("urlImage")
    if image is None:
        image_list = data.get("listUrlImages") or data.get("images")
        if isinstance(image_list, list) and image_list:
            image = image_list[0]
    return {
        "sku": data.get("id"),
        "codigos_barras": data.get("barcodeList", data.get("barcode", [])),
        "nombre": data.get("mediaDescription"),
        "marca": data.get("brand"),
        "precio": data.get("fullPrice"),
        "categoria": data.get("categorie"),
        "imagen": image,
    }


def buscar_productos_farmatodo(query, limit=10):
    """Busca productos por el nombre leído en una etiqueta o hablador."""
    query = " ".join(str(query or "").split())[:120]
    if not query:
        return []
    url = "https://api-search.farmatodo.com/1/indexes/products-venezuela/query"
    try:
        response = session.post(url, json={"query": query, "hitsPerPage": limit}, timeout=(2, 8))
        response.raise_for_status()
        hits = response.json().get("hits", [])
    except (requests.exceptions.RequestException, ValueError) as error:
        print(f"[Audit service] No se pudo buscar el producto {query}: {error}")
        return []
    return [{
        "sku": hit.get("id"),
        "codigos_barras": hit.get("barcodeList", hit.get("barcode", [])),
        "nombre": hit.get("mediaDescription"),
        "marca": hit.get("brand"),
        "precio": hit.get("fullPrice"),
        "categoria": hit.get("categorie"),
        "imagen": hit.get("mediaImageUrl") or hit.get("image") or hit.get("imageUrl"),
    } for hit in hits if hit.get("mediaDescription")]


if __name__ == "__main__":
    print(obtener_producto_farmatodo("115261489"))