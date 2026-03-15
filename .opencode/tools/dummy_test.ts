import { tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import { createOpencodeClient } from '@opencode-ai/sdk';

const DEFAULT_SERVER_URL = process.env.OPENCODE_SERVER_URL ?? "http://127.0.0.1:4096";

/**
 * Dummy test tool - minimal proof-of-concept for parent-child session marker visibility
 */
export const dummyTestTool = tool({
  name: 'dummy_test',
  description: 'Minimal test for parent-child session marker visibility',
  schema: z.object({}),

  async execute(_args, context) {
    const client = createOpencodeClient({ baseUrl: DEFAULT_SERVER_URL });

    const promptText = `Answer the following question in the following format: \`<-- ANSWER "{{your-answer-text}}" -->\` Only respond with the tag. The question is "How are you feeling today?"`;

    console.log('[dummy_test] Creating child session...');

    let sessionID: string | null = null;

    try {
      // Step 1: Create session
      const created = await client.session.create({
        body: { title: 'dummy-test-child' },
      });
      
      const createdSession = created.data as { id?: unknown } | undefined;
      if (!createdSession || typeof createdSession.id !== 'string' || createdSession.id.trim().length === 0) {
        throw new Error('Failed to create session: no ID returned');
      }
      sessionID = createdSession.id;
      console.log(`[dummy_test] Created session: ${sessionID}`);

      // Step 2: Send prompt
      console.log('[dummy_test] Sending prompt...');
      const promptResult = await client.session.prompt({
        path: { id: sessionID },
        body: {
          parts: [{ type: 'text', text: promptText }],
        },
      });

      // Step 3: Extract output from parts
      const parts = promptResult.data?.parts || [];
      const rawOutput = parts
        .filter((p: { type: string; text?: string }) => p.type === 'text')
        .map((p: { type: string; text?: string }) => p.text || '')
        .join('');
      
      console.log(`[dummy_test] Raw child output: ${rawOutput}`);

      // Parse for marker
      const markerRegex = /<--\s*ANSWER\s+"([^"]*)"\s*-->/;
      const match = rawOutput.match(markerRegex);

      const result = {
        success: match !== null,
        markerFound: match !== null,
        extractedAnswer: match ? match[1] : null,
        rawChildOutput: rawOutput,
        sessionId: sessionID,
        timestamp: new Date().toISOString(),
      };

      console.log(`[dummy_test] Marker found: ${result.markerFound}`);
      if (result.extractedAnswer) {
        console.log(`[dummy_test] Extracted answer: ${result.extractedAnswer}`);
      }

      return {
        type: 'object',
        content: result,
      };
    } catch (error) {
      console.error(`[dummy_test] Error: ${error}`);
      return {
        type: 'object',
        content: {
          success: false,
          error: String(error),
          timestamp: new Date().toISOString(),
        },
      };
    } finally {
      // Step 4: Cleanup
      if (sessionID) {
        console.log(`[dummy_test] Cleaning up session: ${sessionID}`);
        await client.session.delete({ path: { id: sessionID } }).catch((err) => {
          console.error(`[dummy_test] Failed to delete session: ${err}`);
        });
      }
    }
  },
});

export default dummyTestTool;
