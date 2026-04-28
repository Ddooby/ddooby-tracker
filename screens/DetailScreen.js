import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import MapView, { Polyline, Marker } from 'react-native-maps';
import { formatDistance, formatDuration } from '../utils/distance';

export default function DetailScreen({ route }) {
  const { walk } = route.params;

  const coords = walk.coords;
  const midIndex = Math.floor(coords.length / 2);
  const center = coords[midIndex] || coords[0];

  const date = new Date(walk.date);
  const dateStr = `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

  return (
    <View style={styles.container}>
      <MapView
        style={styles.map}
        initialRegion={{
          ...center,
          latitudeDelta: 0.01,
          longitudeDelta: 0.01,
        }}
        scrollEnabled={false}
        zoomEnabled={false}
      >
        <Marker coordinate={coords[0]} pinColor="blue" title="출발" />
        <Marker coordinate={coords[coords.length - 1]} pinColor="red" title="도착" />
        <Polyline coordinates={coords} strokeColor="#22c55e" strokeWidth={4} />
      </MapView>

      <View style={styles.infoBox}>
        <Text style={styles.dateText}>{dateStr}</Text>
        <View style={styles.statsRow}>
          <StatItem label="거리" value={formatDistance(walk.distance)} />
          <View style={styles.divider} />
          <StatItem label="시간" value={formatDuration(walk.duration)} />
          <View style={styles.divider} />
          <StatItem
            label="평균속도"
            value={
              walk.duration > 0
                ? `${((walk.distance / 1000) / (walk.duration / 3600)).toFixed(1)}km/h`
                : '-'
            }
          />
        </View>
      </View>
    </View>
  );
}

function StatItem({ label, value }) {
  return (
    <View style={styles.statItem}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  map: { flex: 1 },
  infoBox: {
    padding: 20,
    borderTopWidth: 1,
    borderColor: '#e5e7eb',
  },
  dateText: { fontSize: 14, color: '#6b7280', marginBottom: 16 },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
  },
  statItem: { alignItems: 'center', flex: 1 },
  statValue: { fontSize: 20, fontWeight: '700', color: '#111827' },
  statLabel: { fontSize: 12, color: '#6b7280', marginTop: 4 },
  divider: { width: 1, height: 40, backgroundColor: '#e5e7eb' },
});
