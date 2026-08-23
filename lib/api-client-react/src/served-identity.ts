import { useGetServedBuildIdentity } from "./generated/api";

/**
 * @summary Identity of the exact API build serving this request
 * @dormantExport Consumed when a first-party status surface reads the serving build identity through the generated hook.
 */
export const useServedBuildIdentity = useGetServedBuildIdentity;
