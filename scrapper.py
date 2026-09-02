import os
import sys
import time
import random
import requests
from mysql.connector import Error
from database import get_connection

def guardar_producto(producto_data):
    """Guarda una nueva captura del producto sin reemplazar capturas previas."""
    sql = """
    INSERT INTO productos (sku, codigo_barras, nombre, precio_oficial, estado, actualizado_en)
    VALUES (%s, %s, %s, %s, 'ACTUALIZADO', NOW())
    """
    
    connection = None
    cursor = None
    
    try:
        connection = get_connection()
        cursor = connection.cursor()
        
        # Extraer variables del diccionario de respuesta
        sku = producto_data.get("sku")
        codigos = producto_data.get("codigos_barras", [])
        if isinstance(codigos, (list, tuple)):
            codigo_barras = codigos[0] if codigos else None
        else:
            codigo_barras = codigos or None
        nombre = producto_data.get("nombre")
        precio = producto_data.get("precio")
        
        # Ejecutar la consulta SQL parametrizada (previene SQL Injection)
        cursor.execute(sql, (sku, codigo_barras, nombre, precio))
        connection.commit()
        
        print(f"[BD] Nueva captura del SKU {sku} guardada como 'ACTUALIZADO'.")

    except Error as e:
        print(f"[BD Error] No se pudo guardar el SKU {producto_data.get('sku')}: {e}")
        if connection:
            connection.rollback()
            
    finally:
        # Asegurar la liberación de conexiones al pool
        if cursor:
            cursor.close()
        if connection:
            connection.close()


def consultar_api_farmatodo(sku):
    """Obtiene los datos desde la API pública de Algolia/Farmatodo."""
    url = f"https://api-search.farmatodo.com/1/indexes/products-venezuela/{sku}"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json"
    }

    try:
        response = requests.get(url, headers=headers, timeout=10)
        
        if response.status_code == 200:
            data = response.json()
            return {
                "sku": data.get("id"),
                "codigos_barras": data.get("barcode"),
                "nombre": data.get("mediaDescription"),
                "precio": data.get("fullPrice")
            }
        elif response.status_code == 429:
            print(f"[API Warning] Límite de peticiones alcanzado. Pausando...")
            time.sleep(30)
            return None
        else:
            print(f"[API Error] Código {response.status_code} para SKU {sku}")
            return None

    except requests.exceptions.RequestException as e:
        print(f"[API Error] Falla de red al consultar SKU {sku}: {e}")
        return None


def procesar_lista_skus(lista_skus):
    """Flujo principal: itera la lista, consulta la API y guarda en MySQL."""
    for sku in lista_skus:
        datos_producto = consultar_api_farmatodo(sku)
        
        if datos_producto:
            guardar_producto(datos_producto)
        
        # Pausa aleatoria para protección anti-bloqueo
        tiempo_espera = random.uniform(1.5, 3.0)
        time.sleep(tiempo_espera)

# --- Ejecución de prueba ---
if __name__ == "__main__":
    skus = sys.argv[1:]
    if not skus:
        print("Uso: python scrapper.py SKU [SKU ...]")
        sys.exit(1)
    procesar_lista_skus(skus)