import os 
from dotenv import load_dotenv
import mysql.connector
from mysql.connector import pooling,Error

load_dotenv() #Carga todas la variables de entorno del archivo .env

connection_pool = None
#Configuracion del pool de conexiones
try:
    connection_pool = mysql.connector.pooling.MySQLConnectionPool(
        pool_name = "mypool",
        pool_size = 5,
        pool_reset_session = True,
        host = os.getenv("DB_HOST"),
        user = os.getenv("DB_USER"),
        password = os.getenv("DB_PASSWORD"),
        database = os.getenv("DB_NAME"),
        port = os.getenv("DB_PORT"),
        connection_timeout = 3
    )
    print('Pool de conexiones a MySQL creado exitosamente.')
except Error as e:
    print('Error al crear el pool de conexiones a MySQL:', e)
    
def get_connection():
    if connection_pool is None:
        return None
    try:
        connection = connection_pool.get_connection()
        if connection.is_connected():
            return connection
    except Error as e:
        print('Error al obtener la conexión del pool:', e)
        return None