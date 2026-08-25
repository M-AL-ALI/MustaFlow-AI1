import { and, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { chatMessagesTable, db, knowledgeEntriesTable } from "@workspace/db";
import {
  buildZeroProjectChoiceProfile,
  type ZeroProjectChoiceProfile,
} from "./zero-project-choices";

const MESSAGE_READ_LIMIT = 100;
const KNOWLEDGE_READ_LIMIT = 50;

export async function loadZeroProjectChoices(projectId: number): Promise<ZeroProjectChoiceProfile> {
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    throw new Error("zero_project_choices_subject_invalid");
  }

  const [userMessages, knowledgeEntries] = await Promise.all([
    db
      .select({
        id: chatMessagesTable.id,
        content: chatMessagesTable.content,
        createdAt: chatMessagesTable.createdAt,
      })
      .from(chatMessagesTable)
      .where(and(eq(chatMessagesTable.projectId, projectId), eq(chatMessagesTable.role, "user")))
      .orderBy(desc(chatMessagesTable.createdAt), desc(chatMessagesTable.id))
      .limit(MESSAGE_READ_LIMIT),
    db
      .select({
        id: knowledgeEntriesTable.id,
        type: knowledgeEntriesTable.type,
        content: knowledgeEntriesTable.content,
        createdAt: knowledgeEntriesTable.createdAt,
      })
      .from(knowledgeEntriesTable)
      .where(
        and(
          eq(knowledgeEntriesTable.projectId, projectId),
          inArray(knowledgeEntriesTable.type, ["decision", "rejection"]),
          isNull(knowledgeEntriesTable.archivedAt),
          or(isNull(knowledgeEntriesTable.origin), ne(knowledgeEntriesTable.origin, "ora")),
        ),
      )
      .orderBy(desc(knowledgeEntriesTable.createdAt), desc(knowledgeEntriesTable.id))
      .limit(KNOWLEDGE_READ_LIMIT),
  ]);

  return buildZeroProjectChoiceProfile({
    projectId,
    userMessages: userMessages.map(({ createdAt, ...message }) => ({
      ...message,
      occurredAt: createdAt.toISOString(),
    })),
    knowledgeEntries: knowledgeEntries.flatMap((entry) =>
      entry.type === "decision" || entry.type === "rejection"
        ? [
            {
              id: entry.id,
              type: entry.type,
              content: entry.content,
              occurredAt: entry.createdAt.toISOString(),
            },
          ]
        : [],
    ),
  });
}
