export function validateNewPassword(password: string, confirmation: string): string | undefined {
  if (password.length < 12) return "新しいパスワードは12文字以上で入力してください。";
  if (password !== confirmation) return "新しいパスワードが一致しません。";
  return undefined;
}
