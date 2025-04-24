import { Ai } from '@cloudflare/ai'

export interface Env {
  AI: any;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const query = url.searchParams.get('q');
    
    if (!query) {
      return new Response("Query parameter 'q' is required", { status: 400 });
    }
    
    // Create the AI instance with the binding from env
    const ai = new Ai(env.AI);
    
    // Step 1: Use AI to clean and understand the address
    const prompt = `
You are an address parser. A user provided the following query:
"${query}"
Your task is to:
1. Normalize the query.
2. If the street name seems incorrect or unrecognized, remove or correct it.
3. Return a JSON object with:
 - 'normalized': cleaned version of the input
 - 'neighborhood': if found
 - 'town_or_city': if found
 - 'is_street_valid': true/false depending on whether the street seems valid
Respond ONLY with the JSON object.
`;

    try {
      const result = await ai.run('@cf/meta/llama-2-7b-chat-int8', {
        prompt,
      });
      
      return new Response(result, {
        headers: {
          'Content-Type': 'application/json',
        },
      });
    } catch (error) {
      console.error('AI processing error:', error);
      return new Response(JSON.stringify({ error: 'Failed to process address' }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
        },
      });
    }
  },
};