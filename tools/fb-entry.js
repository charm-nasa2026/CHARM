// Firebase web SDK, bundled once into public/js/firebase.js so the app needs no CDN for it.
import { initializeApp } from 'firebase/app';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, memoryLocalCache, collection, doc, query, where, orderBy, limit, onSnapshot, connectFirestoreEmulator } from 'firebase/firestore';
import { getFunctions, httpsCallable, connectFunctionsEmulator } from 'firebase/functions';
import { getMessaging, getToken, deleteToken, isSupported } from 'firebase/messaging';
window.CHARM_FB = { initializeApp, initializeFirestore, persistentLocalCache, persistentMultipleTabManager, memoryLocalCache, collection, doc, query, where, orderBy, limit, onSnapshot, connectFirestoreEmulator, getFunctions, httpsCallable, connectFunctionsEmulator, getMessaging, getToken, deleteToken, isSupported };
