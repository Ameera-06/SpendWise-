import { initializeApp, FirebaseApp } from 'firebase/app';
import { getAuth, Auth } from 'firebase/auth';
import { initializeFirestore, Firestore, persistentLocalCache, persistentMultipleTabManager } from 'firebase/firestore';

// Configuration for spendwiseapp-77113
const firebaseConfig = {
  apiKey: "AIzaSyAAKblkU3z9Sb5CAN1pG-Y6-UmZg9xmxGI",
  authDomain: "spendwiseapp-77113.firebaseapp.com",
  projectId: "spendwiseapp-77113",
  storageBucket: "spendwiseapp-77113.firebasestorage.app",
  messagingSenderId: "284674617199",
  appId: "1:284674617199:web:302d53312fe6448151029a"
};

const app: FirebaseApp = initializeApp(firebaseConfig);

// Using initializeFirestore with experimentalForceLongPolling to prevent "unavailable" errors
// which are common in restricted cloud environments where WebSockets might be throttled.
const db: Firestore = initializeFirestore(app, {
  experimentalForceLongPolling: true,
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

const auth: Auth = getAuth(app);

export { app, db, auth };

