class MemoryStorage implements Storage {
  #values = new Map<string, string>()
  get length() { return this.#values.size }
  clear() { this.#values.clear() }
  getItem(key: string) { return this.#values.get(String(key)) ?? null }
  key(index: number) { return [...this.#values.keys()][index] ?? null }
  removeItem(key: string) { this.#values.delete(String(key)) }
  setItem(key: string, value: string) { this.#values.set(String(key), String(value)) }
}
export const localStorage = new MemoryStorage()
export const sessionStorage = new MemoryStorage()
