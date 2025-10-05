// utils/user.js
export async function detectUserId() {
  try {
    // Chrome がログインユーザーを返すとは限らないので、拡張の乱数で擬似ID
    const key = "texel_user_id";
    const local = localStorage.getItem(key);
    if (local) return local;
    const v = "u_" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem(key, v);
    return v;
  } catch {
    return "u_" + Date.now().toString(36);
  }
}
