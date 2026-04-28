import { useState, useRef, useCallback } from 'react';
import * as Location from 'expo-location';

export default function useLocation() {
  const [currentLocation, setCurrentLocation] = useState(null);
  const [coords, setCoords] = useState([]);
  const [permissionError, setPermissionError] = useState(false);
  const subscriptionRef = useRef(null);

  const startTracking = useCallback(async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      setPermissionError(true);
      return false;
    }

    const initial = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.BestForNavigation,
    });
    const firstCoord = {
      latitude: initial.coords.latitude,
      longitude: initial.coords.longitude,
    };
    setCurrentLocation(firstCoord);
    setCoords([firstCoord]);

    subscriptionRef.current = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: 2000,
        distanceInterval: 5,
      },
      (loc) => {
        const coord = {
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
        };
        setCurrentLocation(coord);
        setCoords((prev) => [...prev, coord]);
      }
    );

    return true;
  }, []);

  const stopTracking = useCallback(() => {
    if (subscriptionRef.current) {
      subscriptionRef.current.remove();
      subscriptionRef.current = null;
    }
  }, []);

  const resetTracking = useCallback(() => {
    setCoords([]);
    setCurrentLocation(null);
  }, []);

  return {
    currentLocation,
    coords,
    permissionError,
    startTracking,
    stopTracking,
    resetTracking,
  };
}
