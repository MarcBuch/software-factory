export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function responseError(text: string) {
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object" && typeof value.error === "string") return value.error;
  } catch {}
  return text;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) throw new ApiError(responseError(await response.text()), response.status);
  return response.json();
}
