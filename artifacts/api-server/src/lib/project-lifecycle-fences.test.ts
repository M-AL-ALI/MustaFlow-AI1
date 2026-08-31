import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), "utf8");

const lifecycleSource = read("./project-lifecycle.ts");
const retirementSource = read("./project-retirement.ts");
const jobsSource = read("./jobs.ts");
const provisioningSource = read("./provisioning.ts");
const schedulerSource = read("./deployment-scheduler.ts");
const creditsSource = read("./credits.ts");
const publishSource = read("../routes/publish.ts");
const messagesSource = read("../routes/messages.ts");
const buildsSource = read("../routes/builds.ts");
const easRoutesSource = read("../routes/eas.ts");
const securityRoutesSource = read("../routes/security.ts");
const previewEnvSource = read("../routes/preview-env.ts");
const containersSource = read("../routes/containers.ts");
const domainsSource = read("../routes/domains.ts");
const dnsRecordsSource = read("../routes/dns-records.ts");
const runtimeRoutesSource = read("../routes/runtime.ts");
const assetAltTextSource = read("./asset-alt-text-analysis.ts");
const purchasedDomainsSource = read("../routes/purchased-domains.ts");
const databaseSource = read("../routes/database.ts");
const snapshotStorageSource = read("./snapshot-storage.ts");
const sslRoutesSource = read("../routes/ssl.ts");
const versionsSource = read("../routes/versions.ts");
const livePreviewSource = read("./livePreviewProxy.ts");
const agentLoopSource = read("./agent-loop.ts");
const snapshotCaptureSource = read("./db-snapshot-capture.ts");
const domainFulfillmentSource = read("./domain-fulfillment.ts");
const routesIndexSource = read("../routes/index.ts");
const imagesRoutesSource = read("../routes/images.ts");
const imageGenRoutesSource = read("../routes/image-gen.ts");
const packagesRoutesSource = read("../routes/packages.ts");
const workflowsRoutesSource = read("../routes/workflows.ts");
const aiInlineRoutesSource = read("../routes/ai-inline.ts");
const githubRoutesSource = read("../routes/github.ts");
const assetsRoutesSource = read("../routes/assets.ts");
const developerModeRoutesSource = read("../routes/developer-mode.ts");

const routeBlock = (source: string, anchor: string): string => {
  const start = source.indexOf(anchor);
  if (start < 0) throw new Error(`route anchor missing: ${anchor}`);
  const next = source.indexOf("\nrouter.", start + anchor.length);
  return source.slice(start, next < 0 ? undefined : next);
};

describe("project lifecycle mutation fences", () => {
  it("preempts local work before Trash waits on the lifecycle lock", () => {
    const routes = read("../routes/projects.ts");
    const ownerDelete = routeBlock(routes, 'router.delete("/projects/:id"');
    expect(ownerDelete.indexOf("cancelLocalProjectJobs(params.data.id)")).toBeGreaterThan(-1);
    expect(ownerDelete.indexOf("cancelLocalProjectJobs(params.data.id)")).toBeLessThan(
      ownerDelete.indexOf("acceptProjectRetirement({"),
    );
    expect(ownerDelete.indexOf("cancelLocalProjectProvisioning(params.data.id)")).toBeLessThan(
      ownerDelete.indexOf("acceptProjectRetirement({"),
    );
    const adminBatch = routeBlock(routes, 'router.post(\n  "/admin/projects/retirement/batch"');
    expect(adminBatch.indexOf("cancelLocalProjectJobs(projectId)")).toBeGreaterThan(-1);
    expect(adminBatch.indexOf("cancelLocalProjectJobs(projectId)")).toBeLessThan(
      adminBatch.indexOf("acceptProjectRetirement({"),
    );
  });
  it("shares one advisory key between Trash and dedicated provider sessions", () => {
    expect(lifecycleSource).toContain("pool.connect()");
    expect(lifecycleSource).toContain("PROJECT_LIFECYCLE_LOCK_NAMESPACE");
    expect(lifecycleSource).toContain("pg_try_advisory_lock");
    expect(lifecycleSource).toContain("deleted_at IS NULL");
    expect(lifecycleSource).toContain("pg_advisory_unlock");
    expect(retirementSource).toContain(
      "pg_advisory_xact_lock(${PROJECT_LIFECYCLE_LOCK_NAMESPACE}, ${input.projectId})",
    );
  });

  it("fences publish and promote before provider mutation and final persistence", () => {
    expect(
      publishSource.match(/requireActiveProjectLifecycleSession/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(2);
    expect(
      publishSource.match(/lifecycleSession\.assertActive\(\)/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(5);
    expect(publishSource.indexOf("lifecycleSession.assertActive()")).toBeLessThan(
      publishSource.indexOf("deployProductionContainer("),
    );
    expect(publishSource).toContain("production_promotion_persistence_failed");
  });

  it("fences container and preview-database provisioning and exposes local cancellation", () => {
    expect(provisioningSource).toContain("export function cancelLocalProjectProvisioning");
    expect(
      provisioningSource.match(/acquireProjectLifecycleSession\(projectId\)/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(2);
    expect(provisioningSource).toContain("signal: controller.signal");
    expect(provisioningSource).toContain("lifecycleSession.assertActive()");
  });

  it("atomically disables schedules and independently excludes tombstoned projects", () => {
    expect(retirementSource).toContain("disableProjectDeploymentSchedulesStatement(project.id)");
    expect(schedulerSource).toContain("SET enabled = false");
    expect(schedulerSource).toContain("next_run_at = NULL");
    expect(schedulerSource).toContain("innerJoin(projectsTable");
    expect(schedulerSource).toContain("isNull(projectsTable.deletedAt)");
    expect(schedulerSource).toContain("acquireProjectLifecycleSession(row.projectId)");
  });

  it("terminalizes every active task with telemetry, refund, and cleared reservation", () => {
    expect(jobsSource).toContain("export async function retireProjectTasks");
    expect(jobsSource).toContain('flushBuildTokenTelemetry(task.id, "canceled")');
    expect(jobsSource).toContain('taskCreditSettlementKey(task.id, "pipeline")');
    expect(jobsSource).toContain("persistInterruptedZeroTerminal");
    expect(jobsSource).toContain('lastPhase: "project_retirement"');
    expect(jobsSource).toContain("creditsReserved: null");
  });

  it("keeps the charge identity for cycle reversal and a distinct wallet refund receipt", () => {
    expect(creditsSource).toContain("settlementKey: opts.settlementKey");
    expect(creditsSource).toContain(
      "const refundSettlementKey = opts.settlementKey ? `${opts.settlementKey}:refund` : undefined",
    );
    expect(creditsSource).toContain(
      "eq(creditTransactionsTable.settlementKey, refundSettlementKey)",
    );
    expect(creditsSource).toContain('type: "refund"');
    expect(creditsSource).toContain('(error as { code?: unknown }).code === "23505"');
  });

  it("binds plan, answer, EAS, app testing, and CVE work to project admission/cancellation", () => {
    expect(jobsSource).toContain("projectId: number;\n  run: (signal: AbortSignal)");
    expect(messagesSource).toContain("requireActiveProjectLifecycleSession");
    expect(messagesSource).toContain("responseProjectLifecycleSession(res)");
    expect(messagesSource).not.toContain("await releaseLifecycleSession()");
    expect(messagesSource).toContain("registerProjectWorkController(project.id, abortController)");
    expect(jobsSource).toContain("runEasBuildJobActive(input, controller.signal)");
    expect(jobsSource).toContain("runAppTestingJobActive(");
    expect(jobsSource).toContain("runCveAutoProtectJobActive(input, controller.signal)");
  });

  it("applies one systemic HTTP fence and covers non-standard project identities", () => {
    const centralFence = routesIndexSource.indexOf(
      "router.use(requireActiveProjectMutationLifecycleSession)",
    );
    expect(centralFence).toBeGreaterThan(-1);
    for (const mountedRouter of [
      "router.use(messagesRouter)",
      "router.use(snapshotObserveRouter)",
      "router.use(assetsRouter)",
      "router.use(githubRouter)",
      "router.use(containersRouter)",
      "router.use(imagesRouter)",
      "router.use(checkRunsRouter)",
      "router.use(aiInlineRouter)",
    ]) {
      expect(routesIndexSource.indexOf(mountedRouter)).toBeGreaterThan(centralFence);
    }
    for (const source of [
      imagesRoutesSource,
      packagesRoutesSource,
      workflowsRoutesSource,
      aiInlineRoutesSource,
    ]) {
      expect(source).toContain('"/projects/:id/');
    }
    expect(imageGenRoutesSource).toContain("requireActiveProjectLifecycleFor(projectId");
    expect(githubRoutesSource).toContain("acquireProjectLifecycleSession(projectId)");
    expect(githubRoutesSource).toContain("await lifecycleSession.release()");
    expect(assetsRoutesSource).toContain("requireAssetProjectLifecycle");
  });

  it("keeps diagnostic and log observation reads provider-mutation free", () => {
    const runtimeStatusGet = developerModeRoutesSource.slice(
      developerModeRoutesSource.indexOf("router.get("),
      developerModeRoutesSource.indexOf("router.post("),
    );
    expect(runtimeStatusGet).not.toContain("ensureContainerAwake");
    expect(developerModeRoutesSource).toContain(
      '"/projects/:id/developer-mode/runtime-status/wake"',
    );
    const logStream = containersSource.slice(
      containersSource.indexOf('"/projects/:id/container/logs/stream"'),
      containersSource.indexOf("// ── POST /api/projects/:id/container/logs/test"),
    );
    expect(logStream).not.toContain("ensureContainerLogTailer");
  });

  it("denies direct EAS and CVE mutations after Trash", () => {
    expect(buildsSource).toContain("requireActiveProjectLifecycleSession");
    expect(
      easRoutesSource.match(/requireActiveProjectLifecycleSession/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(4);
    expect(securityRoutesSource).toContain("withActiveProjectLifecycle(");
  });

  it("keeps preview observation metadata-only and fences explicit session minting", () => {
    const getSession = previewEnvSource.slice(
      previewEnvSource.indexOf('router.get("/projects/:id/preview-env/session"'),
      previewEnvSource.indexOf("/** Explicit mutation boundary"),
    );
    expect(getSession).not.toContain("generateLaunchToken");
    expect(getSession).not.toContain(".insert(");
    expect(getSession).not.toContain(".update(");
    expect(previewEnvSource).toContain('router.post(\n  "/projects/:id/preview-env/session"');
    expect(previewEnvSource).toContain("requireActiveProjectLifecycleSession");
    expect(previewEnvSource).toContain("acquireProjectLifecycleSession(projectId)");
    expect(previewEnvSource).toContain("registerProjectWorkController(projectId, controller)");
  });

  it("awaits public route closure and never reports maintenance before provider confirmation", () => {
    expect(publishSource).toContain("await syncAllHostnamesKV({");
    expect(publishSource).toContain("await purgeCacheForProject({");
    expect(publishSource).toContain("production_unpublish_provider_cleanup_failed");
    expect(publishSource).toContain("staging_unpublish_route_cleanup_failed");
    expect(publishSource).toContain("const outcome = await setProjectMaintenanceMode");
    expect(publishSource).toContain("maintenance_route_update_failed");
  });

  it("fences direct runtime, domain, purchased-domain, and database provider entries", () => {
    expect(containersSource).toContain("withActiveProjectLifecycle(projectId");
    expect(containersSource).toContain("requireActiveProjectLifecycleSession");
    expect(
      domainsSource.match(/requireActiveProjectLifecycleSession/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(5);
    expect(domainsSource).toContain("await applySecurityConfig");
    expect(domainsSource).toContain("await syncHostnameKVAfterPublish");
    expect(purchasedDomainsSource).toContain("withActiveProjectLifecycle(lifecycleProjectId");
    expect(purchasedDomainsSource).toContain("await activateSslForDomain");
    expect(
      databaseSource.match(/requireActiveProjectLifecycleSession/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(4);
  });

  it("treats an active retirement duplicate as an existing scheduled receipt", () => {
    expect(retirementSource).toContain('if (outcome.status === "duplicate") return operationId');
  });

  it("does not report domain deletion until certificate and route absence are confirmed", () => {
    expect(domainsSource).not.toContain("void deleteCustomHostname(");
    expect(domainsSource).not.toContain("void deleteHostnameKV(");
    expect(domainsSource.match(/await retireCustomHostname/g)?.length ?? 0).toBeGreaterThanOrEqual(
      2,
    );
    expect(domainsSource.match(/await retireHostnameKV/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(domainsSource).toContain("domain_custom_hostname_cleanup_unconfirmed");
    expect(domainsSource).toContain("legacy_domain_route_cleanup_unconfirmed");
    const multiDelete = domainsSource.slice(
      domainsSource.indexOf('router.delete(\n  "/projects/:id/domains/:domainId"'),
      domainsSource.indexOf("// ── PATCH /api/projects/:id/domains/:domainId/primary"),
    );
    expect(multiDelete.indexOf("await retireHostnameKV")).toBeLessThan(
      multiDelete.indexOf("await db.delete(projectDomainsTable)"),
    );
    expect(multiDelete.indexOf("await db.delete(projectDomainsTable)")).toBeLessThan(
      multiDelete.indexOf("res.json({ deleted: true })"),
    );
  });

  it("keeps database and snapshot receipts until provider deletion is confirmed", () => {
    expect(databaseSource).not.toContain("void deleteSnapshotBlob(");
    expect(databaseSource).toContain("const deleted = await deleteNeonDatabase");
    expect(databaseSource).toContain("database_provider_cleanup_unconfirmed");
    expect(databaseSource).toContain("const blobDeleted = await deleteSnapshotBlob");
    expect(databaseSource).toContain("database_snapshot_storage_cleanup_unconfirmed");
    expect(snapshotStorageSource).toContain("Promise<boolean>");
    expect(snapshotStorageSource).toContain("if (!isConfigured()) return false");
    const snapshotDelete = databaseSource.slice(
      databaseSource.indexOf('router.delete(\n  "/projects/:id/database/snapshots/:sid"'),
    );
    expect(snapshotDelete.indexOf("await deleteSnapshotBlob")).toBeLessThan(
      snapshotDelete.indexOf(".delete(dbSnapshotsTable)"),
    );
  });

  it("fences every remaining runtime and SSL provider creation path", () => {
    expect(sslRoutesSource).toContain("requireActiveProjectLifecycleSession");
    expect(versionsSource).toContain("withActiveProjectLifecycle(projectId");
    expect(versionsSource).toContain("lifecycleSession.assertActive()");
    expect(livePreviewSource).toContain("withActiveProjectLifecycle(projectId");
    expect(livePreviewSource).toContain("session.assertActive()");
    expect(
      agentLoopSource.match(/withActiveProjectLifecycle/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(4);
    expect(
      containersSource.match(/requireActiveProjectLifecycleSession/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(5);
    expect(containersSource).toContain("production_container_destroy_unconfirmed");
    expect(containersSource).toContain("preview_container_destroy_unconfirmed");
  });

  it("keeps snapshot upload and domain fulfillment inside lifecycle receipts", () => {
    expect(snapshotCaptureSource).toContain("withActiveProjectLifecycle(projectId");
    expect(snapshotCaptureSource).toContain("await deleteSnapshotBlob(uploadedObjectKey)");
    expect(purchasedDomainsSource).not.toContain("void activateSslForDomain(");
    expect(domainFulfillmentSource).not.toContain("void triggerSsl(");
    expect(domainFulfillmentSource).toContain("withActiveProjectLifecycle(targetProjectId");
    expect(domainFulfillmentSource).toContain("projectId: null");
  });

  it("keeps domain follow-up work inside the request lifecycle lock", () => {
    expect(domainsSource).not.toContain("void enqueueDomainRewriteJob(");
    expect(domainsSource).not.toContain("void activateSslForProject(");
    expect(domainsSource).not.toContain("setImmediate(() =>");
    expect(domainsSource.match(/await enqueueDomainRewriteJob\(/g)?.length ?? 0).toBe(2);
    expect(domainsSource).toContain(
      "await activateSslForProject(projectId, domain, projectForSsl?.cfHostnameId)",
    );

    const attachRoute = domainsSource.slice(
      domainsSource.indexOf('router.post(\n  "/projects/:id/domains"'),
      domainsSource.indexOf("// ── DELETE /api/projects/:id/domains/:domainId"),
    );
    expect(attachRoute.indexOf("await enqueueDomainRewriteJob(")).toBeLessThan(
      attachRoute.indexOf("res.status(201).json("),
    );

    const legacyVerifyRoute = domainsSource.slice(
      domainsSource.indexOf('router.post(\n  "/projects/:id/domain/verify"'),
    );
    expect(legacyVerifyRoute.indexOf("await activateSslForProject(")).toBeLessThan(
      legacyVerifyRoute.indexOf("res.json({"),
    );
  });

  it("holds the lifecycle lock across every DNS and BYO-certificate mutation", () => {
    expect(
      dnsRecordsSource.match(/requireActiveProjectLifecycleSession/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(9);
    for (const providerCall of [
      "createDnsRecord(",
      "updateDnsRecord(",
      "deleteDnsRecord(",
      "uploadCustomCert(",
      "removeCustomCert(",
    ]) {
      expect(dnsRecordsSource).toContain(`await ${providerCall}`);
      expect(dnsRecordsSource).not.toContain(`void ${providerCall}`);
    }
  });

  it("holds the lifecycle lock across add-on, schedule, and environment mutations", () => {
    expect(
      runtimeRoutesSource.match(/requireActiveProjectLifecycleSession/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(7);
    const addonCreate = runtimeRoutesSource.slice(
      runtimeRoutesSource.indexOf("// POST /api/projects/:id/addons"),
      runtimeRoutesSource.indexOf("// DELETE /api/projects/:id/addons/:addonId"),
    );
    const addonDelete = runtimeRoutesSource.slice(
      runtimeRoutesSource.indexOf("// DELETE /api/projects/:id/addons/:addonId"),
      runtimeRoutesSource.indexOf("// ─── Scheduled Job Runs"),
    );
    expect(addonCreate).toContain("requireActiveProjectLifecycleSession");
    expect(addonDelete).toContain("requireActiveProjectLifecycleSession");
    expect(addonCreate.indexOf("requireActiveProjectLifecycleSession")).toBeLessThan(
      addonCreate.indexOf("provisionAddon("),
    );
    expect(addonDelete.indexOf("requireActiveProjectLifecycleSession")).toBeLessThan(
      addonDelete.indexOf(".delete(secretsTable)"),
    );
  });

  it("reacquires lifecycle sessions for detached schedule and promotion callbacks", () => {
    const scheduleTrigger = runtimeRoutesSource.slice(
      runtimeRoutesSource.indexOf("// POST /api/projects/:id/schedules/:sid/trigger"),
      runtimeRoutesSource.indexOf("// ─── Environments"),
    );
    const promotionRoute = runtimeRoutesSource.slice(
      runtimeRoutesSource.indexOf("// POST /api/projects/:id/environments/:envId/promote"),
      runtimeRoutesSource.indexOf("// ─── Usage / Metering"),
    );
    const scheduledJob = runtimeRoutesSource.slice(
      runtimeRoutesSource.indexOf("async function executeScheduledJob("),
      runtimeRoutesSource.indexOf("async function executeEnvironmentPromotion("),
    );
    const environmentPromotion = runtimeRoutesSource.slice(
      runtimeRoutesSource.indexOf("async function executeEnvironmentPromotion("),
      runtimeRoutesSource.indexOf("/**\n * Provision a managed add-on."),
    );

    expect(scheduleTrigger).toContain("setImmediate(() =>");
    expect(scheduleTrigger).toContain(
      "executeScheduledJob(runRow.id, scheduleId, projectId, schedule)",
    );
    expect(promotionRoute).toContain("setImmediate(() =>");
    expect(promotionRoute).toContain("executeEnvironmentPromotion({");

    expect(scheduledJob).toContain("acquireProjectLifecycleSession(projectId)");
    expect(scheduledJob.indexOf("acquireProjectLifecycleSession(projectId)")).toBeLessThan(
      scheduledJob.indexOf("execInContainer("),
    );
    expect(scheduledJob).toContain(
      'errorMessage: "Project lifecycle unavailable before scheduled job started"',
    );
    expect(scheduledJob.indexOf("if (!lifecycleSession)")).toBeLessThan(
      scheduledJob.indexOf("execInContainer("),
    );
    expect(
      scheduledJob.slice(
        scheduledJob.indexOf("if (!lifecycleSession)"),
        scheduledJob.indexOf("\n  try {"),
      ),
    ).not.toContain("execInContainer(");
    expect(scheduledJob).toContain("await lifecycleSession.release()");

    expect(environmentPromotion).toContain("acquireProjectLifecycleSession(input.projectId)");
    expect(environmentPromotion).toContain(
      'notes: "Project lifecycle unavailable before environment promotion started"',
    );
    expect(environmentPromotion.indexOf("if (!lifecycleSession)")).toBeLessThan(
      environmentPromotion.indexOf("const [targetEnv]"),
    );
    expect(
      environmentPromotion.slice(
        environmentPromotion.indexOf("if (!lifecycleSession)"),
        environmentPromotion.indexOf("\n  try {"),
      ),
    ).not.toContain("execInContainer(");
    expect(environmentPromotion).toContain("await lifecycleSession.release()");
  });

  it("cancels queued project vision work and fences any claimed provider call", () => {
    expect(retirementSource).toContain(".update(assetAnalysisEventsTable)");
    expect(retirementSource).toContain(
      'inArray(assetAnalysisEventsTable.status, ["queued", "started"])',
    );
    expect(retirementSource).toContain('status: "canceled"');
    expect(assetAltTextSource).toContain("projectId: number | null");
    expect(assetAltTextSource).toContain("withActiveProjectLifecycle(input.projectId");
    const wrapper = assetAltTextSource.slice(
      assetAltTextSource.indexOf("export async function runAssetAltTextAnalysis"),
      assetAltTextSource.indexOf("export async function enqueueAutomaticAssetAltText"),
    );
    const projectLifecycle = wrapper.indexOf("withActiveProjectLifecycle");
    expect(projectLifecycle).toBeGreaterThan(-1);
    expect(wrapper.indexOf("runActiveAssetAltTextAnalysis", projectLifecycle)).toBeGreaterThan(
      projectLifecycle,
    );
    expect(assetAltTextSource).toContain("projectId: assetAnalysisEventsTable.projectId");
  });
});
