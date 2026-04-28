import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = '@walks_history';

export async function saveWalk(walk) {
  const existing = await getWalks();
  const updated = [walk, ...existing];
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
}

export async function getWalks() {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  return raw ? JSON.parse(raw) : [];
}

export async function deleteWalk(id) {
  const existing = await getWalks();
  const updated = existing.filter((w) => w.id !== id);
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
}
