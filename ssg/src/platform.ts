export const isAndroid = () => Boolean(import.meta.env.VITE_ANDROID);
export const isNative = () => isAndroid() || Boolean(import.meta.env.VITE_DESKTOP);
