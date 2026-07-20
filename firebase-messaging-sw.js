// firebase-messaging-sw.js
// Bu fayl saytning ROOT papkasida (index.html bilan bir joyda) turishi shart,
// aks holda push notification ilova yopiq bo'lganda ishlamaydi.

importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDB0-xOCIiIIaYE57FlLFJtXTYsfw4UdkM",
  authDomain: "shokh-s-project.firebaseapp.com",
  databaseURL: "https://shokh-s-project-default-rtdb.firebaseio.com",
  projectId: "shokh-s-project",
  storageBucket: "shokh-s-project.firebasestorage.app",
  messagingSenderId: "1052896898568",
  appId: "1:1052896898568:web:dcf5cd2fc4d1910545ebbd"
});

const messaging = firebase.messaging();

// Ilova/tab yopiq yoki background'da bo'lganda kelgan push shu yerda ko'rsatiladi
messaging.onBackgroundMessage((payload) => {
  const title = (payload.notification && payload.notification.title) || 'Sikl Kuzatuvchi';
  const body = (payload.notification && payload.notification.body) || '';
  const options = {
    body,
    icon: 'https://twemoji.maxcdn.com/v/latest/72x72/1f338.png',
    badge: 'https://twemoji.maxcdn.com/v/latest/72x72/1f338.png'
  };
  self.registration.showNotification(title, options);
});
