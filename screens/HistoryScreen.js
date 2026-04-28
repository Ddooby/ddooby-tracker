import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Alert,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { getWalks, deleteWalk } from '../storage/walkStorage';
import { formatDistance, formatDuration } from '../utils/distance';

export default function HistoryScreen({ navigation }) {
  const [walks, setWalks] = useState([]);

  useFocusEffect(
    useCallback(() => {
      getWalks().then(setWalks);
    }, [])
  );

  const handleDelete = (id) => {
    Alert.alert('삭제', '이 산책 기록을 삭제할까요?', [
      {
        text: '삭제',
        style: 'destructive',
        onPress: async () => {
          await deleteWalk(id);
          setWalks((prev) => prev.filter((w) => w.id !== id));
        },
      },
      { text: '취소', style: 'cancel' },
    ]);
  };

  const renderItem = ({ item }) => {
    const date = new Date(item.date);
    const dateStr = `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`;
    const timeStr = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

    return (
      <TouchableOpacity
        style={styles.card}
        onPress={() => navigation.navigate('Detail', { walk: item })}
        onLongPress={() => handleDelete(item.id)}
      >
        <View style={styles.cardLeft}>
          <Text style={styles.dateText}>{dateStr}</Text>
          <Text style={styles.timeText}>{timeStr}</Text>
        </View>
        <View style={styles.cardRight}>
          <Text style={styles.distanceText}>{formatDistance(item.distance)}</Text>
          <Text style={styles.durationText}>{formatDuration(item.duration)}</Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      {walks.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>아직 산책 기록이 없습니다.</Text>
          <Text style={styles.emptySubText}>첫 산책을 시작해보세요 🐾</Text>
        </View>
      ) : (
        <FlatList
          data={walks}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9fafb' },
  list: { padding: 16, gap: 10 },
  card: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 4,
    elevation: 2,
  },
  cardLeft: {},
  dateText: { fontSize: 16, fontWeight: '600', color: '#111827' },
  timeText: { fontSize: 13, color: '#6b7280', marginTop: 2 },
  cardRight: { alignItems: 'flex-end' },
  distanceText: { fontSize: 18, fontWeight: '700', color: '#22c55e' },
  durationText: { fontSize: 13, color: '#6b7280', marginTop: 2 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyText: { fontSize: 16, color: '#374151', fontWeight: '600' },
  emptySubText: { fontSize: 14, color: '#9ca3af', marginTop: 8 },
});
