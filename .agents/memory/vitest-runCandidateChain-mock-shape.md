---
name: runCandidateChain mock must return full CandidateChainResult shape
description: Mocking runCandidateChain with a primitive (e.g. "") causes chain.result.choices[0] TypeError; must return the full object.
---

## Rule

`runCandidateChain` returns `CandidateChainResult`: `{ result: ChatCompletion, usedFallback: boolean, candidate: ModelCandidate }`. Routes immediately destructure `chain.result.choices[0].message.content`. Any mock returning `""` or `null` throws a TypeError before the route can respond.

**Why:** The previous default mock returned `""` (a leftover from early scaffolding). The conversational route path accesses `.choices[0]` inline, so the 502 / TypeError happened for every test that reached the conversational branch.

**How to apply:** Always return:
```typescript
vi.fn().mockResolvedValue({
  result: { choices: [{ message: { content: "Test reply" } }] },
  usedFallback: false,
  candidate: { provider: "openai", model: "gpt-5-mini" },
})
```
