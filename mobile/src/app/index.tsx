import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import Constants from 'expo-constants';
import * as FileSystem from 'expo-file-system/legacy';
import * as Speech from 'expo-speech';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, Colors, MaxContentWidth, Spacing } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

function getApiUrl() {
  const configuredUrl = process.env.EXPO_PUBLIC_API_URL?.trim();
  if (configuredUrl) return configuredUrl.replace(/\/$/, '');

  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    return `http://${window.location.hostname}:8000`;
  }

  const hostUri = Constants.expoConfig?.hostUri ?? Constants.platform?.hostUri;
  const host = hostUri?.split(':')[0];
  return host ? `http://${host}:8000` : 'http://127.0.0.1:8000';
}

const API_URL = getApiUrl();
const STORAGE_KEY = 'farmatodo-auditoria-registro-v1';

type Product = {
  sku?: string | number;
  id?: string | number;
  nombre?: string;
  name?: string;
  precio_oficial?: number | string;
  precio?: number | string;
  precio_anaquel?: number | string;
  imagen?: string;
  image?: string;
};

type ShelfResult = {
  precios_detectados: { precio: number; valor_leido: string }[];
  confianza: number;
  texto?: string;
  comparaciones?: { precio?: number; sku?: string; codigos_barras_producto?: string | number | (string | number)[]; nombre?: string; imagen?: string; precio_oficial?: number; coincide: boolean; estado: string; diferencia?: number | null }[];
  para_cambiar?: { precio?: number; nombre?: string; precio_oficial?: number; diferencia?: number | null }[];
  productos_identificados?: number;
};

function getImageType(filename: string) {
  const extension = filename.split('.').pop()?.toLowerCase();
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  return 'image/jpeg';
}

async function uploadImage(uri: string, filename: string, endpoint: string, query = '') {
  if (Platform.OS === 'web') {
    const imageBlob = await (await fetch(uri)).blob();
    const querySeparator = query ? `&${query}` : '';
    return fetchWithTimeout(`${API_URL}${endpoint}/raw?filename=${encodeURIComponent(filename)}${querySeparator}`, {
      method: 'POST',
      headers: { 'Content-Type': getImageType(filename) },
      body: imageBlob,
    }, 60000);
  }
  const upload = FileSystem.uploadAsync(`${API_URL}${endpoint}${query ? `?${query}` : ''}`, uri, {
    uploadType: FileSystem.FileSystemUploadType.MULTIPART,
    fieldName: 'file',
    mimeType: getImageType(filename),
    parameters: { filename },
  });
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Tiempo agotado conectando con ${API_URL}`)), 60000));
  const result = await Promise.race([upload, timeout]);
  return new Response(result.body, { status: result.status, headers: { 'Content-Type': 'application/json' } });
}

async function compressImage(uri: string) {
  const result = await ImageManipulator.manipulateAsync(
    uri,
    [{ resize: { width: 1600 } }],
    { compress: 0.55, format: ImageManipulator.SaveFormat.JPEG },
  );
  if (Platform.OS === 'web' || !FileSystem.documentDirectory) return result.uri;
  const permanentUri = `${FileSystem.documentDirectory}auditoria-${Date.now()}.jpg`;
  await FileSystem.copyAsync({ from: result.uri, to: permanentUri });
  return permanentUri;
}

async function readApiResponse(response: Response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { detail: text || `El servidor respondio HTTP ${response.status}.` };
  }
}

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function toPrice(value: unknown) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function getProductId(product: Product) {
  return String(product.sku ?? product.id ?? product.nombre ?? 'producto-sin-identificador');
}

function uniqueProducts(products: Product[]) {
  const seen = new Set<string>();
  return products.filter((product) => {
    const id = getProductId(product);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function normalizeImageName(filename: string, fallback: string) {
  const cleanName = filename.trim();
  return /\.(jpe?g|png|webp)$/i.test(cleanName) ? cleanName : fallback;
}

function isSupportedImage(filename: string) {
  return /\.(jpe?g|png|webp)$/i.test(filename);
}

function isSupportedMime(mimeType?: string) {
  return !mimeType || ['image/jpeg', 'image/png', 'image/webp'].includes(mimeType.toLowerCase());
}

export default function HomeScreen() {
  const colorScheme = useColorScheme();
  const theme = Colors[colorScheme === 'dark' ? 'dark' : 'light'];
  const [products, setProducts] = useState<Product[]>([]);
  const [shelfPrices, setShelfPrices] = useState<Record<string, string>>({});
  const [images, setImages] = useState<Record<string, string>>({});
  const [ocrLoading, setOcrLoading] = useState<Record<string, boolean>>({});
  const [ocrStatus, setOcrStatus] = useState<Record<string, string>>({});
  const [comparisonStates, setComparisonStates] = useState<Record<string, 'coincide' | 'cambiar' | 'sin_precio_detectado'>>({});
  const [sku, setSku] = useState('');
  const [skuLoading, setSkuLoading] = useState(false);
  const [shelfPhoto, setShelfPhoto] = useState<string | null>(null);
  const [shelfResult, setShelfResult] = useState<ShelfResult | null>(null);
  const [shelfLoading, setShelfLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [storageReady, setStorageReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((saved) => {
      if (saved) {
        const record = JSON.parse(saved);
        setProducts(record.products ?? []);
        setImages(record.images ?? {});
        setShelfPrices(record.shelfPrices ?? {});
        setComparisonStates(record.comparisonStates ?? {});
      }
    }).catch(() => undefined).finally(() => setStorageReady(true));
    fetchWithTimeout(`${API_URL}/productos`, {}, 45000)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((data) => setProducts((current) => uniqueProducts([
        ...current,
        ...(Array.isArray(data) ? data : data.productos ?? []),
      ])))
      .catch((requestError) => setError(requestError instanceof Error && requestError.name === 'AbortError'
        ? `La API no responde en ${API_URL}. Verifica que el teléfono y el PC estén en la misma Wi-Fi.`
        : `No se pudieron cargar los productos desde ${API_URL}.`))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (storageReady) {
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ products, images, shelfPrices, comparisonStates })).catch(() => undefined);
    }
  }, [products, images, shelfPrices, comparisonStates, storageReady]);

  async function addSku() {
    const requestedSku = sku.trim();
    if (!requestedSku) {
      Alert.alert('SKU requerido', 'Escribe el SKU del producto para buscarlo.');
      return;
    }

    setSkuLoading(true);
    setError(null);
    try {
      const response = await fetchWithTimeout(`${API_URL}/productos/actualizar/${encodeURIComponent(requestedSku)}`, { method: 'POST' }, 10000);
      const data = await readApiResponse(response);
      if (!response.ok) throw new Error(data.detail ?? 'No se encontró el producto.');
      setProducts((current) => uniqueProducts([data, ...current.filter((product) => getProductId(product) !== String(data.sku))]));
      setSku('');
    } catch (requestError) {
      setError(requestError instanceof Error && requestError.name === 'AbortError'
        ? 'La búsqueda tardó demasiado. Intenta nuevamente.'
        : requestError instanceof Error ? requestError.message : 'No se pudo buscar el SKU.');
    } finally {
      setSkuLoading(false);
    }
  }

  async function scanShelf(uri: string, filename: string) {
    setShelfPhoto(uri);
    setShelfLoading(true);
    setShelfResult(null);
    try {
      const safeFilename = 'anaquel.jpg';
      const compressedUri = await compressImage(uri);
      const response = await uploadImage(compressedUri, safeFilename, '/ocr/anaquel');
      const data = await readApiResponse(response);
      if (!response.ok) throw new Error(data.detail ?? 'No se pudo leer el anaquel.');
      setShelfResult(data);
      const count = data.precios_detectados?.length ?? 0;
      Speech.speak(count ? `Se detectaron ${count} precios en el anaquel.` : 'No se detectaron precios en el anaquel.');
    } catch (scanError) {
      Alert.alert('No se pudo leer el anaquel', scanError instanceof Error && scanError.name === 'AbortError'
        ? `Tiempo agotado. La API debe estar accesible desde el teléfono: ${API_URL}`
        : scanError instanceof Error ? scanError.message : 'Intenta con otra foto.');
    } finally {
      setShelfLoading(false);
    }
  }

  function removeShelfPhoto() {
    setShelfPhoto(null);
    setShelfResult(null);
    Speech.stop();
  }

  async function preparePhoto(uri: string, filename: string, fallback: string, mimeType?: string) {
    const safeFilename = normalizeImageName(filename, fallback);
    setShelfPhoto(uri);
    setShelfResult(null);
    if (!isSupportedMime(mimeType) || !isSupportedImage(safeFilename)) {
      Alert.alert('Formato no compatible', 'Usa una imagen JPG, PNG o WEBP.');
      return null;
    }
    return { filename: safeFilename, uri: await compressImage(uri) };
  }

  async function selectShelfPhoto() {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    Alert.alert('Permiso requerido', 'Debes permitir el acceso a tus fotos para cargar una imagen.');
    return;
  }
  const result = await ImagePicker.launchImageLibraryAsync({ 
    mediaTypes: ['images'], 
    quality: 0.8, // Calidad sugerida para equilibrar OCR y velocidad (~500KB)
    allowsEditing: false, 
    exif: true,
  });
  if (!result.canceled) {
    const asset = result.assets[0];
    await preparePhoto(asset.uri, asset.fileName ?? 'anaquel.jpg', 'anaquel.jpg', asset.mimeType);
  }
}

async function takeShelfPhoto() {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    Alert.alert('Permiso requerido', 'Debes permitir el uso de la cámara para tomar una foto.');
    return;
  }
  const result = await ImagePicker.launchCameraAsync({ 
    mediaTypes: ['images'], 
    quality: 0.8, 
    allowsEditing: false, 
    exif: true,
  });
  if (!result.canceled) {
    const asset = result.assets[0];
    await preparePhoto(asset.uri, asset.fileName ?? 'anaquel.jpg', 'anaquel.jpg', asset.mimeType);
  }
}

  async function recognizePrice(productId: string, uri: string, filename: string, productSku = productId) {
    setOcrLoading((current) => ({ ...current, [productId]: true }));
    setOcrStatus((current) => ({ ...current, [productId]: 'Leyendo precio con OCR...' }));
    try {
      const safeFilename = 'captura.jpg';
      const compressedUri = await compressImage(uri);
      const response = await uploadImage(compressedUri, safeFilename, '/ocr', `sku=${encodeURIComponent(productSku)}`);
      const data = await readApiResponse(response);
      if (!response.ok) throw new Error(data.detail ?? 'No se pudo leer la imagen.');
      if (data.precio_detectado !== null) {
        if (data.estado) setComparisonStates((current) => ({ ...current, [productId]: data.estado }));
        setShelfPrices((current) => ({ ...current, [productId]: String(data.precio_detectado) }));
        const confidence = Math.round(data.confianza * 100);
        setOcrStatus((current) => ({
          ...current,
          [productId]: data.coincide === true
            ? `Coincide con Farmatodo · ${confidence}% de confianza`
            : data.coincide === false
              ? `Difiere de Farmatodo por ${Math.abs(data.diferencia ?? 0)} Bs · ${confidence}% de confianza`
              : confidence >= 80
                ? `Precio detectado · ${confidence}% de confianza`
                : `Precio detectado · verifica la lectura (${confidence}%)`,
        }));
        Speech.speak(`Precio detectado: ${data.precio_detectado} bolivares. Confianza ${Math.round(data.confianza * 100)} por ciento.`);
      } else {
        setOcrStatus((current) => ({ ...current, [productId]: 'No hay una lectura segura. Ingresa el precio manualmente.' }));
        Speech.speak('No se encontro una lectura segura. Ingresa el precio manualmente.');
      }
    } catch (ocrError) {
      setOcrStatus((current) => ({ ...current, [productId]: 'OCR no disponible. Ingresa el precio manualmente.' }));
      Alert.alert('No se pudo leer el precio', ocrError instanceof Error ? ocrError.message : 'Intenta con otra foto.');
    } finally {
      setOcrLoading((current) => ({ ...current, [productId]: false }));
    }
  }

  function removePhoto(productId: string) {
    setImages((current) => {
      const next = { ...current };
      delete next[productId];
      return next;
    });
    setOcrStatus((current) => {
      const next = { ...current };
      delete next[productId];
      return next;
    });
    setShelfPrices((current) => {
      const next = { ...current };
      delete next[productId];
      return next;
    });
    setComparisonStates((current) => {
      const next = { ...current };
      delete next[productId];
      return next;
    });
    Speech.stop();
  }

  async function selectPhoto(productId: string) {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permiso requerido', 'Debes permitir el acceso a tus fotos para cargar una imagen.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.45,
      exif: false,
    });
    if (!result.canceled) {
      const asset = result.assets[0];
        if (!isSupportedMime(asset.mimeType)) {
          Alert.alert('Formato no compatible', 'Usa una imagen JPG, PNG o WEBP.');
          return;
        }
      const compressedUri = await compressImage(asset.uri);
      setImages((current) => ({ ...current, [productId]: compressedUri }));
      setOcrStatus((current) => ({ ...current, [productId]: 'Foto cargada. Pulsa Enviar y analizar.' }));
    }
  }

  async function takePhoto(productId: string) {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permiso requerido', 'Debes permitir el uso de la cámara para tomar una foto.');
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      quality: 0.45,
      exif: false,
    });
    if (!result.canceled) {
      const asset = result.assets[0];
        if (!isSupportedMime(asset.mimeType)) {
          Alert.alert('Formato no compatible', 'Usa una imagen JPG, PNG o WEBP.');
          return;
        }
      const compressedUri = await compressImage(asset.uri);
      setImages((current) => ({ ...current, [productId]: compressedUri }));
      setOcrStatus((current) => ({ ...current, [productId]: 'Foto cargada. Pulsa Enviar y analizar.' }));
    }
  }

  function renderProduct({ item }: { item: Product }) {
    const id = getProductId(item);
    const officialPrice = toPrice(item.precio_oficial ?? item.precio);
    const shelfPrice = toPrice(shelfPrices[id]);
    const hasPhoto = Boolean(images[id]);
    const isCompared = officialPrice !== null && shelfPrice !== null;
    const hasMismatch = comparisonStates[id] === 'cambiar' || (officialPrice !== null && shelfPrice !== null && officialPrice !== shelfPrice);

    return (
      <ThemedView style={[styles.product, { backgroundColor: theme.backgroundElement, borderColor: theme.border }, hasMismatch && styles.mismatch]}>
        {hasPhoto || item.imagen || item.image ? (
          <Image source={{ uri: images[id] ?? item.imagen ?? item.image }} style={styles.photo} />
        ) : <View style={styles.photoPlaceholder} />}
        <ThemedText style={[styles.productName, { color: theme.text }]}>{item.nombre ?? item.name ?? 'Producto sin nombre'}</ThemedText>
        <View style={styles.priceRow}>
          <ThemedText style={[styles.priceLabel, { color: theme.textSecondary }]}>Precio Farmatodo</ThemedText>
          <ThemedText style={[styles.officialPrice, { color: theme.text }]}>
            {officialPrice === null ? 'No disponible' : `${officialPrice} Bs`}
          </ThemedText>
        </View>
        <View style={styles.actions}>
          <Pressable style={styles.button} onPress={() => selectPhoto(id)}>
            <ThemedText style={styles.buttonText}>{images[id] ? 'Cambiar imagen' : 'Cargar imagen'}</ThemedText>
          </Pressable>
          <Pressable style={[styles.button, styles.cameraButton]} onPress={() => takePhoto(id)}>
            <ThemedText style={styles.buttonText}>{images[id] ? 'Repetir foto' : 'Tomar foto'}</ThemedText>
          </Pressable>
        </View>
        {hasPhoto ? (
          <View style={styles.photoActions}>
            <Pressable style={styles.analyzeButton} onPress={() => recognizePrice(id, images[id], 'captura.jpg', String(item.sku ?? item.id ?? id))} disabled={ocrLoading[id]}>
              <ThemedText style={styles.buttonText}>{ocrLoading[id] ? 'Analizando...' : 'Enviar y analizar'}</ThemedText>
            </Pressable>
            <Pressable style={styles.deleteButton} onPress={() => removePhoto(id)}>
              <ThemedText style={styles.deleteText}>Eliminar foto</ThemedText>
            </Pressable>
          </View>
        ) : null}
        <ThemedText style={[styles.status, !isCompared && styles.pending, hasMismatch ? styles.warning : styles.match]}>
          {ocrLoading[id] ? 'Leyendo precio con OCR... ' : ocrStatus[id] ? `${ocrStatus[id]} ` : ''}
          {comparisonStates[id] === 'cambiar' ? `Precio incorrecto: ${shelfPrice} Bs en foto · Farmatodo: ${officialPrice} Bs` : comparisonStates[id] === 'coincide' ? 'Precio correcto según Farmatodo' : !isCompared ? 'Ingresa el precio del anaquel para comparar.' : hasMismatch ? `Revisar: ${shelfPrice} Bs en anaquel` : ''}
        </ThemedText>
      </ThemedView>
    );
  }

  return (
    <ThemedView style={[styles.container, { backgroundColor: theme.background }]}>
      <SafeAreaView style={styles.safeArea}>
        <ScrollView style={styles.mainScroll} contentContainerStyle={styles.mainContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator>
        <View style={styles.header}>
          <View style={styles.brandRow}>
            <View style={styles.brandMark}><ThemedText style={styles.brandMarkText}>F</ThemedText></View>
            <ThemedText style={styles.kicker}>FARMATODO · CONTROL DE TIENDA</ThemedText>
          </View>
          <ThemedText style={[styles.title, { color: theme.text }]}>Auditoria de precios</ThemedText>
        </View>
        <View style={[styles.searchBox, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
          <ThemedText style={[styles.searchLabel, { color: theme.text }]}>Agregar producto por SKU</ThemedText>
          <View style={styles.searchRow}>
            <TextInput
              style={[styles.skuInput, { backgroundColor: theme.background, borderColor: theme.border, color: theme.text }]}
              value={sku}
              onChangeText={setSku}
              onSubmitEditing={addSku}
              placeholder="Ej. 115921504"
              placeholderTextColor={theme.textSecondary}
              keyboardType="number-pad"
              returnKeyType="search"
            />
            <Pressable style={styles.searchButton} onPress={addSku} disabled={skuLoading}>
              {skuLoading ? <ActivityIndicator color="#ffffff" /> : <ThemedText style={styles.buttonText}>Buscar</ThemedText>}
            </Pressable>
          </View>
          <ThemedText style={[styles.searchLabel, { color: theme.text }]}>Auditar anaquel completo</ThemedText>
          <View style={styles.searchRow}>
            <Pressable style={[styles.searchButton, styles.shelfButton]} onPress={selectShelfPhoto}>
              <ThemedText style={styles.buttonText}>Cargar foto</ThemedText>
            </Pressable>
            <Pressable style={[styles.searchButton, styles.cameraButton]} onPress={takeShelfPhoto}>
              <ThemedText style={styles.buttonText}>Tomar foto</ThemedText>
            </Pressable>
          </View>
          {shelfPhoto ? <Image source={{ uri: shelfPhoto }} style={styles.shelfPhoto} resizeMode="contain" /> : null}
          {shelfPhoto ? (
            <View style={styles.photoActions}>
              <Pressable style={styles.analyzeButton} onPress={() => scanShelf(shelfPhoto, 'anaquel.jpg')} disabled={shelfLoading}>
                <ThemedText style={styles.buttonText}>{shelfLoading ? 'Analizando...' : 'Enviar y analizar'}</ThemedText>
              </Pressable>
              <Pressable style={styles.deleteButton} onPress={removeShelfPhoto}>
                <ThemedText style={styles.deleteText}>Eliminar foto</ThemedText>
              </Pressable>
            </View>
          ) : null}
          {shelfLoading ? <ActivityIndicator color="#0875c1" /> : null}
          {shelfResult ? (
            <View style={styles.shelfResult}>
              <ThemedText style={styles.searchLabel}>Precios detectados: {shelfResult.precios_detectados.length}</ThemedText>
              <ThemedText style={styles.resultText}>{shelfResult.precios_detectados.map((item) => `${item.precio} Bs`).join('  |  ') || 'Ninguno'}</ThemedText>
              {shelfResult.precios_detectados.length === 0 ? (
                <>
                  <ThemedText style={styles.warning}>No se reconocieron números. Acerca la etiqueta, mejora la luz y toma la foto de frente.</ThemedText>
                  {shelfResult.texto ? <ThemedText style={styles.resultHint}>Texto leído: {shelfResult.texto}</ThemedText> : null}
                </>
              ) : shelfResult.comparaciones?.length ? (
                <View style={styles.comparisonList}>
                  <ThemedText style={styles.resultText}>
                    {shelfResult.comparaciones.filter((item) => item.estado === 'cambiar').length
                      ? `${shelfResult.comparaciones.filter((item) => item.estado === 'cambiar').length} precio(s) deben cambiarse`
                      : shelfResult.comparaciones.some((item) => item.sku && item.precio_oficial !== undefined)
                        ? 'Precios verificados contra Farmatodo'
                        : 'No se pudo encontrar una coincidencia en Farmatodo'}
                  </ThemedText>
                  {shelfResult.para_cambiar?.length ? (
                    <View style={styles.changeList}>
                      <ThemedText style={styles.warning}>Cambios requeridos ({shelfResult.para_cambiar.length})</ThemedText>
                      {shelfResult.para_cambiar.map((product, index) => (
                        <ThemedText key={`${product.nombre}-${index}`} style={styles.warning}>
                          {product.nombre ?? 'Producto'}: colocar {product.precio_oficial} Bs en vez de {product.precio} Bs
                        </ThemedText>
                      ))}
                    </View>
                  ) : null}
                  {shelfResult.comparaciones.map((comparison, index) => (
                    <View key={`${comparison.precio}-${index}`} style={[styles.comparisonCard, comparison.estado === 'cambiar' && styles.comparisonCardError, comparison.coincide && styles.comparisonCardMatch]}>
                      {comparison.imagen ? <Image source={{ uri: comparison.imagen }} style={styles.resultImage} /> : null}
                      <View style={styles.comparisonBody}>
                        <ThemedText style={styles.comparisonName}>{comparison.nombre ?? 'Producto no identificado en Farmatodo'}</ThemedText>
                        <ThemedText style={styles.identifierText}>SKU: {comparison.sku ?? 'No disponible'} · Código: {Array.isArray(comparison.codigos_barras_producto) ? comparison.codigos_barras_producto[0] : comparison.codigos_barras_producto ?? 'No disponible'}</ThemedText>
                        <ThemedText style={comparison.coincide ? styles.match : comparison.estado === 'cambiar' ? styles.warning : styles.pending}>
                          {comparison.coincide ? 'PRECIO CORRECTO' : comparison.estado === 'cambiar' ? 'PRECIO INCORRECTO · CAMBIAR' : comparison.estado === 'sin_precio_detectado' ? 'PRODUCTO IDENTIFICADO · PRECIO NO LEIDO' : 'SIN COINCIDENCIA CONFIABLE'}
                        </ThemedText>
                        <View style={styles.comparisonPrices}>
                          <ThemedText style={styles.priceHint}>Foto: <ThemedText style={styles.priceValue}>{comparison.precio === undefined ? 'No leído' : `${comparison.precio} Bs`}</ThemedText></ThemedText>
                          <ThemedText style={styles.priceHint}>Farmatodo: <ThemedText style={styles.priceValue}>{comparison.precio_oficial == null ? 'No disponible' : `${comparison.precio_oficial} Bs`}</ThemedText></ThemedText>
                        </View>
                      </View>
                    </View>
                  ))}
                </View>
              ) : <ThemedText style={styles.warning}>Se leyeron los precios, pero no se identificó un producto con suficiente seguridad. Revisa el texto OCR: {shelfResult.texto || 'sin texto leído'}.</ThemedText>}
              <ThemedText style={styles.resultHint}>Confianza general: {Math.round(shelfResult.confianza * 100)}%. Verifica cada etiqueta antes de guardar.</ThemedText>
            </View>
          ) : null}
        </View>
        {loading ? <ActivityIndicator /> : null}
        {error ? <ThemedText style={styles.warning}>{error}</ThemedText> : null}
        {!loading ? (
          <View style={styles.registeredSection}>
            <ThemedText style={[styles.searchLabel, { color: theme.text }]}>Registro guardado por SKU</ThemedText>
            <View style={styles.list}>
            {products.length ? products.map((product) => (
              <View key={getProductId(product)} style={styles.productSlot}>
                {renderProduct({ item: product })}
              </View>
            )) : (
              <ThemedView style={styles.emptyState}>
                <ThemedText type="subtitle">No hay productos para auditar.</ThemedText>
                <ThemedText>Verifica que el backend esté encendido y que responda en {API_URL}/productos.</ThemedText>
              </ThemedView>
            )}
            </View>
          </View>
        ) : null}
        </ScrollView>
      </SafeAreaView>
    </ThemedView>
  );
}
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f8fa',
  },
  safeArea: {
    flex: 1,
    width: '100%',
    paddingHorizontal: Spacing.four,
    alignItems: 'center',
    gap: Spacing.four,
    paddingBottom: BottomTabInset + Spacing.three,
    maxWidth: MaxContentWidth,
  },
  title: {
    color: '#12372d',
    fontSize: 32,
    lineHeight: 38,
    fontWeight: '800',
  },
  kicker: { color: '#0875c1', fontSize: 12, fontWeight: '800', letterSpacing: 1 },
  subtitle: { color: '#42534c', fontSize: 16, lineHeight: 23 },
  header: { width: '100%', gap: Spacing.one, paddingTop: Spacing.four },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  brandMark: { width: 30, height: 30, borderRadius: 15, backgroundColor: '#0875c1', alignItems: 'center', justifyContent: 'center' },
  brandMarkText: { color: '#ffffff', fontSize: 20, fontWeight: '800' },
  summary: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two, marginTop: Spacing.two },
  summaryNumber: { color: '#b42318', fontSize: 24, fontWeight: '800' },
  summaryLabel: { color: '#42534c', fontSize: 14 },
  searchBox: { width: '100%', gap: Spacing.two, padding: Spacing.four, backgroundColor: '#ffffff', borderRadius: Spacing.three, borderWidth: 1, borderColor: '#dbe5df', shadowColor: '#12372d', shadowOpacity: 0.06, shadowRadius: 14, elevation: 2 },
  searchLabel: { color: '#12372d', fontSize: 15, fontWeight: '700' },
  searchRow: { flexDirection: 'row', gap: Spacing.two },
  skuInput: { flex: 1, minWidth: 0, borderWidth: 1, borderColor: '#b8c2bd', borderRadius: Spacing.two, paddingHorizontal: Spacing.two, color: '#12372d', fontSize: 16, backgroundColor: '#ffffff' },
  searchButton: { minWidth: 96, minHeight: 44, paddingHorizontal: Spacing.three, borderRadius: Spacing.two, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0875c1' },
  analyzeButton: { padding: Spacing.two, borderRadius: Spacing.two, alignItems: 'center', backgroundColor: '#12372d' },
  photoActions: { flexDirection: 'row', gap: Spacing.two },
  deleteButton: { flex: 1, padding: Spacing.two, borderRadius: Spacing.two, alignItems: 'center', backgroundColor: '#fff1f0', borderWidth: 1, borderColor: '#d64545' },
  deleteText: { color: '#b42318', fontSize: 14, fontWeight: '700' },
  shelfButton: { flex: 1 },
  shelfPhoto: { width: '100%', height: 220, borderRadius: Spacing.two, backgroundColor: '#e6f2ee' },
  shelfResult: { gap: Spacing.one, paddingTop: Spacing.two },
  comparisonList: { gap: Spacing.one },
  comparisonRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  comparisonCard: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two, padding: Spacing.two, borderRadius: Spacing.two, borderWidth: 1, borderColor: '#d8c78d', backgroundColor: '#fffaf0' },
  comparisonCardError: { borderColor: '#d64545', backgroundColor: '#fff1f0' },
  comparisonCardMatch: { borderColor: '#8bc9af', backgroundColor: '#f0faf5' },
  comparisonBody: { flex: 1, minWidth: 0, gap: 2 },
  comparisonName: { fontSize: 14, fontWeight: '700', color: '#12372d' },
  identifierText: { fontSize: 11, color: '#66736d' },
  comparisonPrices: { flexDirection: 'row', gap: Spacing.three, flexWrap: 'wrap' },
  priceHint: { fontSize: 13, color: '#66736d' },
  priceValue: { fontWeight: '800', color: '#12372d' },
  resultImage: { width: 42, height: 42, borderRadius: Spacing.one, backgroundColor: '#e6f2ee' },
  changeList: { gap: Spacing.one, padding: Spacing.two, borderRadius: Spacing.one, backgroundColor: '#fff1f0', borderWidth: 1, borderColor: '#d64545' },
  resultText: { color: '#12372d', fontSize: 18, fontWeight: '800' },
  resultHint: { color: '#66736d', fontSize: 13, lineHeight: 18 },
  list: {
    width: '100%',
    gap: Spacing.three,
    paddingVertical: Spacing.three,
  },
  mainScroll: {
    width: '100%',
    flex: 1,
  },
  mainContent: {
    width: '100%',
    alignItems: 'center',
    gap: Spacing.three,
    paddingBottom: BottomTabInset + Spacing.four,
  },
  registeredSection: {
    width: '100%',
    gap: Spacing.one,
  },
  productSlot: {
    width: '100%',
  },
  product: {
    width: '100%',
    gap: Spacing.two,
    padding: Spacing.three,
    borderRadius: Spacing.two,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#dbe5df',
    shadowColor: '#12372d',
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 2,
  },
  mismatch: {
    borderWidth: 2,
    borderColor: '#d64545',
  },
  photo: {
    width: '100%',
    height: 180,
    borderRadius: Spacing.two,
  },
  photoPlaceholder: {
    width: '100%',
    height: 180,
    borderRadius: Spacing.two,
    backgroundColor: '#e9f1ed',
    borderWidth: 1,
    borderColor: '#cbdad2',
  },
  productName: { color: '#12372d', fontSize: 21, lineHeight: 27, fontWeight: '700' },
  priceRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  priceLabel: { color: '#42534c', fontSize: 14 },
  officialPrice: { color: '#12372d', fontSize: 18, fontWeight: '800' },
  input: {
    borderWidth: 1,
    borderColor: '#b8c2bd',
    borderRadius: Spacing.two,
    padding: Spacing.two,
    backgroundColor: '#ffffff',
    color: '#12372d',
    fontSize: 16,
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  button: {
    flex: 1,
    padding: Spacing.two,
    borderRadius: Spacing.two,
    alignItems: 'center',
    backgroundColor: '#0875c1',
  },
  cameraButton: {
    backgroundColor: '#168a61',
  },
  buttonText: {
    color: '#ffffff',
    fontWeight: '600',
  },
  warning: {
    color: '#b42318',
    fontWeight: '700',
  },
  status: { fontSize: 14, lineHeight: 20, fontWeight: '700' },
  pending: { color: '#8a5a00' },
  match: { color: '#176b52' },
  emptyState: {
    gap: Spacing.two,
    padding: Spacing.three,
    borderRadius: Spacing.two,
    backgroundColor: '#ffffff',
  },
  code: {
    textTransform: 'uppercase',
  },
  stepContainer: {
    gap: Spacing.three,
    alignSelf: 'stretch',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.four,
    borderRadius: Spacing.four,
  },
});
