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
    const ai:any = new Ai(env.AI);
    
    // Step 1: Use AI to clean and understand the address
    const prompt = `
You are an address parser. A user provided the following query:
"${query}"
You are a specialized address corrector and formatter. Your task is to:
            1. Correct any misspellings in the address
            2. Identify and fill in any missing components if possible
            3. Format the address properly
            4. Provide confidence level in your corrections

            Respond in JSON format with:
            {
              "correctedAddress": "the fully corrected address string",
              "corrections": ["list of specific corrections made"],
              "confidence": 0.0-1.0 (how confident you are in the corrections)
            }`

    try {
      const result:any = await ai.run('@cf/google/gemma-3-12b-it', {
        prompt,
      });
      
      // Clean and parse the result
      let cleanResult;
      
      try {
        // First attempt: try parsing directly if it's already valid JSON
        cleanResult = typeof result === 'object' ? result : JSON.parse(result);
      } catch (parseError) {
        // Second attempt: try to clean the string and then parse
        try {
          // Remove any extra quotes or escape characters that might be causing issues
          const cleanedString = result.replace(/\\n/g, '')  // Remove newline escapes
                                     .replace(/\\"/g, '"')   // Replace escaped quotes
                                     .replace(/^['"]|['"]$/g, ''); // Remove surrounding quotes
                                     
          // Try to extract only the JSON part (in case there's extra text)
          const jsonMatch = cleanedString.match(/\{.*\}/s);
          
          if (jsonMatch) {
            cleanResult = JSON.parse(jsonMatch[0]);
          } else {
            throw new Error('Could not extract valid JSON from response');
          }
        } catch (cleanError) {
          console.error('Error cleaning result:', cleanError);
          throw new Error('Failed to parse AI response as JSON');
        }
      }
      
      return new Response(JSON.stringify(cleanResult), {
        headers: {
          'Content-Type': 'application/json',
        },
      });
    } catch (error) {
      console.error('Processing error:', error);
      return new Response(JSON.stringify({ 
        error: 'Failed to process address', 
        details: error.message
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
        },
      });
    }
  },
};
