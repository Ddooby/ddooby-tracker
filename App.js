import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createStackNavigator } from '@react-navigation/stack';
import { Text } from 'react-native';

import HomeScreen from './screens/HomeScreen';
import HistoryScreen from './screens/HistoryScreen';
import DetailScreen from './screens/DetailScreen';

const Tab = createBottomTabNavigator();
const Stack = createStackNavigator();

function HistoryStack() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: '#fff' },
        headerTintColor: '#111827',
        headerTitleStyle: { fontWeight: '700' },
      }}
    >
      <Stack.Screen name="History" component={HistoryScreen} options={{ title: '산책 기록' }} />
      <Stack.Screen name="Detail" component={DetailScreen} options={{ title: '상세 경로' }} />
    </Stack.Navigator>
  );
}

export default function App() {
  return (
    <NavigationContainer>
      <Tab.Navigator
        screenOptions={{
          tabBarActiveTintColor: '#22c55e',
          tabBarInactiveTintColor: '#9ca3af',
          tabBarStyle: { borderTopWidth: 1, borderColor: '#e5e7eb' },
          headerStyle: { backgroundColor: '#fff' },
          headerTintColor: '#111827',
          headerTitleStyle: { fontWeight: '700' },
        }}
      >
        <Tab.Screen
          name="Walk"
          component={HomeScreen}
          options={{
            title: '산책',
            tabBarLabel: '산책',
            tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>🗺</Text>,
          }}
        />
        <Tab.Screen
          name="HistoryTab"
          component={HistoryStack}
          options={{
            headerShown: false,
            title: '기록',
            tabBarLabel: '기록',
            tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>📋</Text>,
          }}
        />
      </Tab.Navigator>
    </NavigationContainer>
  );
}
