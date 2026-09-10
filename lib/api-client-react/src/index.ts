export * from "./generated/api";
export * from "./generated/api.schemas";
export {
  customFetch,
  setBaseUrl,
  setAuthTokenGetter,
  getAuthToken,
  ApiError,
  ResponseParseError,
} from "./custom-fetch";
export type { AuthTokenGetter, ErrorType, BodyType } from "./custom-fetch";
