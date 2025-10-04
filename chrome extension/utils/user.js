// utils/user.js
export async function detectUserId () {
  let uid = localStorage.getItem('texel_uid');
  if (!uid) {
    try {
      uid = (crypto.randomUUID?.() ||
             [...crypto.getRandomValues(new Uint8Array(16))]
               .map(b => b.toString(16).padStart(2, '0')).join(''));
    } catch (_) {                               // Safari など fallback
      uid = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }
    localStorage.setItem('texel_uid', uid);
  }
  return uid;
}
