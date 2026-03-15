import { tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import { OpenCodeSDK } from '../sdk/index.js';
import { Logger } from '../utils/logger.js';

/**
 * Dummy test tool - minimal proof-of-concept for parent-child session marker visibility
 */
export const dummyTestTool = tool({
  name: 'dummy_test',
  description: 'Minimal test for parent-child session marker visibility',
  schema: z.object({}),

  async execute(_args, context) {
    const logger = new Logger('dummy_test');
    const sdk = new OpenCodeSDK();

    const prompt = `Answer the following question in the following format: \`<-- ANSWER "{{your-answer-text}}" -->\` Only respond with the tag. The question is "How are you feeling today?"`;

    logger.info('Spawning child session with dummy prompt...');
    logger.debug(`Prompt: ${prompt}`);

    try {
      const childSession = await sdk.session.spawn({
        prompt,
        agent: 'general',
        timeout: 30000,
      });

      logger.info('Child session spawned, waiting for completion...');
      const childResult = await childSession.waitForCompletion();

      const rawOutput = childResult.output || '';
      logger.debug(`Raw child output: ${rawOutput}`);

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

      logger.info(`Marker found: ${result.markerFound}`);
      if (result.extractedAnswer) {
        logger.info(`Extracted answer: ${result.extractedAnswer}`);
      }

      return {
        type: 'object',
        content: result,
      };
    } catch (error) {
      logger.error(`Error in dummy test: ${error}`);
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
