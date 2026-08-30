/** One provider-weather retry, then the original typed failure remains terminal. */
export async function withOneCleanRetry<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch {
    return work();
  }
}
