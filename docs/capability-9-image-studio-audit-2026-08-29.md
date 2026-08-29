# Capability 9: Image Studio and visual-input audit

Date: 2026-08-29  
Read base: `8bf2fe343060d00bcd6a410d17bb85a13a12edd7`  
Environment: production UI plus read-only source inspection  
Database: none

## Ruling

**KEEP AND ABSORB INTO THE SHARED ASSET SYSTEM.** Image Studio performs real generation,
upload, edit, history, download, and deletion work and holds durable user assets. It is not
safe to remove. Its separate storage and project-insertion seams are replaced by Capability
9's shared registry and authenticated asset routes. The global Studio remains a focused
creative surface; Zero, project chat, preview capture, and the project image panel consume the
same asset records.

## Per-feature evidence

| Feature        | Executes today                               | Lands in a project                                                                     | Zero knows it                                   | Provenance             | Finding and cause                                                                                                                                                                                          |
| -------------- | -------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generate       | Yes: `/api/images/generate` and durable jobs | Only when generated with a `projectId`; global Studio does not offer project selection | Project panel can generate through the same API | Image row only         | Real prior art, but not one asset contract.                                                                                                                                                                |
| Upload         | Yes: `/api/images/upload`                    | No from the global Studio                                                              | No                                              | Image row only         | Separate multer/R2 path; 10 MB rule conflicts with the founder's account allowance.                                                                                                                        |
| Edit           | Yes: `/api/images/:id/edit`                  | Child image retains optional project scope                                             | No direct Zero tool                             | Parent/child image row | Real lineage, but outside project-version provenance.                                                                                                                                                      |
| History        | Yes: `/api/images?limit=40`                  | Filter exists when callers pass `projectId`                                            | Project panel reads the filter                  | No build receipt       | Global and project views are separate presentations of generated_images.                                                                                                                                   |
| Render         | **Broken in production**                     | N/A                                                                                    | N/A                                             | N/A                    | The page renders stored private R2 URLs directly. The authenticated `/api/images/:id/file` route already works with private R2, but the UI does not use it. Historical cards therefore show broken images. |
| Download       | Unreliable for private R2                    | N/A                                                                                    | N/A                                             | N/A                    | Download also uses `fileUrl` directly instead of the authenticated file route.                                                                                                                             |
| Use in Project | **Absent**                                   | No                                                                                     | No                                              | No                     | The visible button is disabled and says `Coming soon`. The project image panel separately downloads an image through `/api/images/:id/file` and writes a base64 project file.                              |
| Delete         | Soft-delete only                             | Does not remove an inserted project-file copy                                          | No                                              | No deletion receipt    | The database row is hidden, but R2 bytes are not removed and references are not checked.                                                                                                                   |
| Credits        | Generation/edit debit credits                | N/A                                                                                    | N/A                                             | Credit ledger          | Upload correctly costs zero credits, but vision-analysis cost is not a separate metered line.                                                                                                              |
| Safety         | Prompt moderation and image validation exist | N/A                                                                                    | N/A                                             | Partial                | No malware verdict, no shared archive/path-traversal contract, and no account storage admission counter.                                                                                                   |

## Related visual paths

- Project chat already accepts image paste/drop and document attachments in
  `zero-agent-panel.tsx`, but images and documents use separate endpoints and the document path
  is backed by Replit/Google object storage, not R2.
- Preview Observe now captures real PNG bytes and passes them transiently to the model, but the
  thread stores only a text message. The user cannot see the exact sent image and it cannot be
  recalled later.
- Visual Edit changes source for a conservative static-HTML subset, but writes the file directly.
  It does not create a restorable version or typed intent/provenance receipt, and it cannot batch a
  session into one version.
- The project image panel can generate and insert a Studio image into project files, but its model
  also trusts direct `fileUrl`/`thumbnailUrl` values for Studio cards.

## Preventive direction

1. One account-scoped asset registry and quota counter; every new byte has provenance and a
   tenant/project/thread scope.
2. Private bytes are served only by authenticated asset routes; public storage URLs never enter
   UI contracts.
3. All intake surfaces call one upload client and one admission service.
4. Deletion is permitted only when the where-used index is empty, then deletes R2 bytes and emits
   a receipt.
5. Snapshot/region captures persist as version-bound assets and the chat displays the persisted
   image it sent.
6. Existing generated_images and project_uploads metadata are backfilled into the registry before
   their legacy consumers are retired.

## Incidental findings

1. **Broken private-R2 rendering (launch-visible).** Evidence: live production Image Studio showed
   alt text in place of historical images while the console remained clean; source uses private
   `fileUrl` directly. Fix belongs to the first Capability 9 wave and is guarded by a UI test that
   requires authenticated `/api/images/:id/file` URLs.
2. **Delete is not byte deletion.** The route updates `deleted_at`; it does not delete R2. Fix is
   folded into the shared deletion coordinator and guarded with referenced/unreferenced tests.
3. **Object-storage split.** Project documents use Replit/Google object storage while images use R2.
   New uploads move to R2; legacy rows remain readable until a governed migration proves each copy.
4. **Transient preview pixels.** Observe sends pixels to the model but stores no image asset. The
   first visual-input wave persists and displays the capture and adds a zero-raw-image-log test.
