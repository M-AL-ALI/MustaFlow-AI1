export const ZERO_SEALED_PROJECT_TYPE_INCOMPATIBLE =
  "zero_sealed_project_type_incompatible" as const;

export const ZERO_SEALED_PROJECT_TYPE_MESSAGE =
  "This website needs to be converted to the supported production format before it can build.";

export const ZERO_SEALED_PROJECT_TYPE_RECOVERY = {
  label: "Convert and build",
  prompt:
    "Convert this project to the supported production website format, keep its requested design and content, and build it again.",
} as const;

export const ZERO_SEALED_PROJECT_TYPE_SUGGESTIONS = [
  "Convert the project to the supported production website format and build it again.",
] as const;

export const ZERO_SEALED_SOURCE_REPAIR_MESSAGE =
  "This website needs one compatibility repair before it can finish building.";

export const ZERO_SEALED_SOURCE_REPAIR_RECOVERY = {
  label: "Repair and build",
  prompt:
    "Repair this website for the supported production format without changing its requested design or content, rerun every required check, and finish the build.",
} as const;

export const ZERO_SEALED_SOURCE_REPAIR_SUGGESTIONS = [
  "Repair the website for the supported production format and finish the build.",
] as const;

export type ZeroSealedProjectRoutingReason =
  | "native_node_application"
  | "convertible_website"
  | "mobile_project"
  | "unsupported_web_stack"
  | "unsupported_project_kind";

export type ZeroSealedProjectRoutingDecision =
  | {
      eligible: true;
      reason: "native_node_application" | "convertible_website";
      stack: "node-api";
      projectFormat: "static-html";
      changed: boolean;
    }
  | {
      eligible: false;
      reason: Exclude<
        ZeroSealedProjectRoutingReason,
        "native_node_application" | "convertible_website"
      >;
    };

/**
 * Resolve the project metadata that selects the sealed source generator.
 *
 * A plain website is represented historically as either static-html or
 * react-vite. The sealed generator implements that product surface as a
 * compiled Node/Express application, so those two website labels are
 * canonicalized deliberately. Other stacks remain closed until their own
 * source contract exists.
 */
export function resolveZeroSealedProjectRouting(input: {
  projectKind: string;
  platform: string | null | undefined;
  stack: string;
  projectFormat: string | null;
  isMobile: boolean;
}): ZeroSealedProjectRoutingDecision {
  if (input.isMobile || input.platform === "ios" || input.platform === "android") {
    return { eligible: false, reason: "mobile_project" };
  }
  if (input.projectKind !== "web") {
    return { eligible: false, reason: "unsupported_project_kind" };
  }
  if (input.stack === "node-api") {
    return {
      eligible: true,
      reason: "native_node_application",
      stack: "node-api",
      projectFormat: "static-html",
      changed: input.projectFormat !== "static-html",
    };
  }
  if (input.stack === "react-vite" || input.stack === "static-html") {
    return {
      eligible: true,
      reason: "convertible_website",
      stack: "node-api",
      projectFormat: "static-html",
      changed: true,
    };
  }
  return { eligible: false, reason: "unsupported_web_stack" };
}
