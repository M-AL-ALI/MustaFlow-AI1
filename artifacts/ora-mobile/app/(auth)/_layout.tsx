import { useAuth } from "@clerk/expo";
import { Redirect, Stack } from "expo-router";
import React from "react";

export default function AuthLayout() {
  const { isSignedIn, isLoaded } = useAuth();
  if (isLoaded && isSignedIn) return <Redirect href="/" />;
  return <Stack screenOptions={{ headerShown: false }} />;
}
