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
    const client = createOpencodeClient({ serverUrl: DEFAULT_SERVER_URL });

    const prompt = `Answer the following question in the following format: \`<-- ANSWER "{{your-answer-text}}" -->\` Only respond with the tag. The question is "How are you feeling today?"`;

    console.log('[dummy_test] Spawning child session with dummy prompt...');

    try {
      const childSession = await client.session.spawn({
        prompt,
        agent: 'general',
        timeout: 30000,
      });

      console.log('[dummy_test] Child session spawned, waiting for completion...');
      const childResult = await childSession.waitForCompletion();

      const rawOutput = childResult.output || '';
      console.log(`[dummy_test] Raw child output: ${rawOutput}`);

      // Parse for marker
      const markerRegex = /<--\s*ANSWER\s+"([^"]*)"\s*-->/;
      const match = rawOutput.match(markerRegex);

      const result = {
        success: match !== null,
        markerFound: match !== null,
        extractedAnswer: match ? match[1] : null,
        rawChildOutput: rawOutput,
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
    }
  },
});

export default dummyTestTool;
