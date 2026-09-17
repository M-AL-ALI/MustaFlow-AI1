export type BuilderRequestFailureNotice = {
  status: number | null;
  title: string;
  description: string;
  tone: "error" | "warning";
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** Use status only: response bodies can contain HTML, private prompts, or secrets. */
export function describeBuilderRequestFailure(error: unknown): BuilderRequestFailureNotice {
  const source = record(error);
  const response = record(source?.response);
  const candidate = source?.status ?? source?.statusCode ?? response?.status;
  const status =
    typeof candidate === "number" &&
    Number.isInteger(candidate) &&
    candidate >= 400 &&
    candidate <= 599
      ? candidate
      : null;

  if (status === 403) {
    return {
      status,
      title: "Request blocked",
      description:
        "The request was rejected (HTTP 403). Check your access or contact support. Your submitted text is kept below; no automatic retry was made.",
      tone: "error",
    };
  }
  if (status === 401) {
    return {
      status,
      title: "Sign-in needs attention",
      description:
        "The request was not accepted (HTTP 401). Check your sign-in before sending again. Your submitted text is kept below.",
      tone: "error",
    };
  }
  if (status === 429) {
    return {
      status,
      title: "Too many requests",
      description:
        "Please wait before sending again. Your submitted text is kept below; no automatic retry was made.",
      tone: "warning",
    };
  }
  return {
    status,
    title: "Request not confirmed",
    description:
      "We could not confirm the result of this request. A task may still have started; check the task queue before sending again. Your submitted text is kept below.",
    tone: "warning",
  };
}
