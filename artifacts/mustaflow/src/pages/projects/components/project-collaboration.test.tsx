import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "src/pages/projects/components/project-collaboration.tsx"),
  "utf8",
);
const acceptSource = readFileSync(
  resolve(process.cwd(), "src/pages/project-invite-accept.tsx"),
  "utf8",
);
const appSource = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");

describe("project collaboration user surface", () => {
  it("offers project-scoped email and private-link invitations with role explanations", () => {
    expect(source).toContain("Invite people to this project only");
    expect(source).toContain('createInvite("email")');
    expect(source).toContain('createInvite("link")');
    expect(source).toContain("Owner");
    expect(source).toContain("Publisher");
    expect(source).toContain("Editor");
    expect(source).toContain("Read-only");
    expect(source).toContain("The email could not be delivered. Copy the private link");
  });

  it("shows members and gives managers role, remove, and revoke controls", () => {
    expect(source).toContain("People with access");
    expect(source).toContain("updateRole(member");
    expect(source).toContain("removeMember(member)");
    expect(source).toContain("revokeInvite(invite)");
  });

  it("warns about owner-funded usage before accepting and routes into the exact project", () => {
    expect(acceptSource).toContain("workspace owner&apos;s NabuFlow credits");
    expect(acceptSource).toContain("Accept and open project");
    expect(acceptSource).toContain("navigate(`/projects/${body.projectId}`)");
    expect(appSource).toContain('<Route path="/projects/invites/:token">');
  });
});
