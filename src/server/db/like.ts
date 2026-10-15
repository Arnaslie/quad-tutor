export const escapeLike = (text: string) => text.replace(/[\\%_]/g, "\\$&");
