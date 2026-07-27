import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.fable.race',
  appName: 'Fable Race',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
};

export default config;
