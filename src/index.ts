// src/index.ts
import { Agent, routeAgentRequest } from 'agents';
import { OpenAI } from "openai";
import { Hono } from 'hono';
import { cors } from 'hono/cors';

interface Env {
  AddressAgent: AgentNamespace;
  OPENAI_API_KEY: string;
}

interface FormattedAddress {
  street?: string;
  neighbourhood?: string;
  town?: string;
  localGovernment?: string;
  state?: string;
  formattedQuery: string;
  alternativeQueries?: {
    neighbourhoodOnly?: string;
    townOnly?: string;
    localGovernmentOnly?: string;
  };
}

// The Agent class that handles address processing
export class AddressFormatterAgent extends Agent {
  // Initialize state if needed
  async init() {
    // Set initial state
    this.setState({
      processedAddresses: [],
      correctionStats: {
        spellingCorrected: 0,
        missingComponentsAdded: 0,
        totalProcessed: 0
      }
    });
  }

  // HTTP request handler
  async onRequest(request: Request) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    if (path === '/format-address' && request.method === 'POST') {
      return this.handleFormatAddress(request);
    } else if (path === '/search' && request.method === 'GET') {
      return this.handleSearch(request);
    } else if (path === '/stats' && request.method === 'GET') {
      return this.getStats();
    } else {
      return new Response('Nominatim Address Formatter API - AI Agent Edition', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
  }

  // Process an address through AI correction
  async correctAddress(address: string): Promise<{
    correctedAddress: string;
    corrections: string[];
    confidence: number;
  }> {
    try {
      const ai = new OpenAI({
        apiKey: this.env.OPENAI_API_KEY,
      });

      const response = await ai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: `You are a specialized address corrector and formatter. Your task is to:
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
          },
          {
            role: "user",
            content: `Correct this address: "${address}"`
          }
        ],
        response_format: { type: "json_object" }
      });

      const result = JSON.parse(response.choices[0].message.content);
      
      // Update stats
      const currentStats = this.state.correctionStats;
      if (result.corrections.length > 0) {
        currentStats.spellingCorrected++;
      }
      currentStats.totalProcessed++;
      
      this.setState({
        ...this.state,
        correctionStats: currentStats,
        processedAddresses: [...this.state.processedAddresses, {
          original: address,
          corrected: result.correctedAddress,
          timestamp: new Date().toISOString()
        }].slice(-100) // Keep only the last 100 processed addresses
      });
      
      return result;
    } catch (error) {
      console.error("Error correcting address:", error);
      return {
        correctedAddress: address,
        corrections: [],
        confidence: 0
      };
    }
  }

  // Format the corrected address into components
  async formatAddress(address: string): Promise<FormattedAddress> {
    // First, clean the address
    const cleanedAddress = address
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();

    // Remove descriptive components
    const withoutDescriptives = cleanedAddress
      // Remove house numbers (patterns like "123", "123a", "no. 123", "number 123")
      .replace(/\b(?:no\.|number)?\s*\d+[a-z]?\b/g, '')
      // Remove directional prefixes
      .replace(/\b(?:off|adjacent to|beside|near|opposite|behind|in front of|next to)\b\s*/gi, '')
      // Remove other common fillers
      .replace(/\b(?:the|at|on|in)\b\s*/gi, '')
      // Clean up any multiple spaces created by the removals
      .replace(/\s+/g, ' ')
      .trim();

    // Split the address by commas or other common separators
    const parts = withoutDescriptives
      .split(/[,\/\\]/g)
      .map(part => part.trim())
      .filter(part => part.length > 0);

    // Initialize formatted address object
    const formattedAddress: FormattedAddress = {
      formattedQuery: ''
    };

    // Assign parts to the appropriate address components
    if (parts.length >= 1) formattedAddress.street = parts[0];
    if (parts.length >= 2) {
      // Determine if second part is neighborhood or town
      if (parts[1].includes('district') || parts[1].includes('area') || parts[1].includes('quarter')) {
        formattedAddress.neighbourhood = parts[1];
        if (parts.length >= 3) formattedAddress.town = parts[2];
      } else {
        formattedAddress.town = parts[1];
      }
    }
    if (parts.length >= 3 && !formattedAddress.town) {
      formattedAddress.localGovernment = parts[2];
    } else if (parts.length >= 4) {
      formattedAddress.localGovernment = parts[3];
    }
    
    if (parts.length >= 4 && !formattedAddress.localGovernment) {
      formattedAddress.state = parts[3];
    } else if (parts.length >= 5) {
      formattedAddress.state = parts[4];
    }

    // Build formatted query string
    const queryParts = [];
    if (formattedAddress.street) queryParts.push(formattedAddress.street);
    if (formattedAddress.neighbourhood) queryParts.push(formattedAddress.neighbourhood);
    if (formattedAddress.town) queryParts.push(formattedAddress.town);
    if (formattedAddress.localGovernment) queryParts.push(formattedAddress.localGovernment);
    if (formattedAddress.state) queryParts.push(formattedAddress.state);

    formattedAddress.formattedQuery = queryParts.join(', ');

    // Generate alternative queries
    formattedAddress.alternativeQueries = {
      neighbourhoodOnly: formattedAddress.neighbourhood ? formattedAddress.neighbourhood : undefined,
      townOnly: formattedAddress.town ? formattedAddress.town : undefined,
      localGovernmentOnly: formattedAddress.localGovernment ? formattedAddress.localGovernment : undefined
    };

    return formattedAddress;
  }

  // Generate Nominatim URL for a query
  generateNominatimUrl(query: string): string {
    return `https://nm.latlens.com/nominatim/search?q=${encodeURIComponent(query)}&format=json`;
  }

  // Handle the format-address endpoint
  async handleFormatAddress(request: Request): Promise<Response> {
    try {
      const body = await request.json();
      
      if (!body.address) {
        return new Response(JSON.stringify({ error: 'Address is required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Correct address using AI
      const correctionResult = await this.correctAddress(body.address);
      
      // Format the corrected address
      const formattedAddress = await this.formatAddress(correctionResult.correctedAddress);
      
      // Generate Nominatim URLs
      const nominatimUrl = this.generateNominatimUrl(formattedAddress.formattedQuery);
      
      // Generate alternative URLs for specific components
      const alternativeUrls = {};
      if (formattedAddress.alternativeQueries?.neighbourhoodOnly) {
        alternativeUrls['neighbourhoodOnly'] = this.generateNominatimUrl(formattedAddress.alternativeQueries.neighbourhoodOnly);
      }
      if (formattedAddress.alternativeQueries?.townOnly) {
        alternativeUrls['townOnly'] = this.generateNominatimUrl(formattedAddress.alternativeQueries.townOnly);
      }
      if (formattedAddress.alternativeQueries?.localGovernmentOnly) {
        alternativeUrls['localGovernmentOnly'] = this.generateNominatimUrl(formattedAddress.alternativeQueries.localGovernmentOnly);
      }

      return new Response(JSON.stringify({
        original: body.address,
        corrected: correctionResult.correctedAddress,
        corrections: correctionResult.corrections,
        confidence: correctionResult.confidence,
        formatted: formattedAddress,
        nominatimUrl,
        alternativeUrls
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Error processing address:', error);
      return new Response(JSON.stringify({ error: 'Failed to process address' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  // Handle the search endpoint
  async handleSearch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const query = url.searchParams.get('q');
    
    if (!query) {
      return new Response(JSON.stringify({ error: 'Query parameter is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const correctionResult = await this.correctAddress(query);
    const formattedAddress = await this.formatAddress(correctionResult.correctedAddress);
    const nominatimUrl = this.generateNominatimUrl(formattedAddress.formattedQuery);

    try {
      const response = await fetch(nominatimUrl);
      const data = await response.json();
      
      // Check if we got results
      let alternativeResults = {};
      
      // If no results or very few, try with alternative queries
      if (data.length < 2) {
        const alternativeQueries = formattedAddress.alternativeQueries;
        
        // Try alternative queries to get more results
        if (alternativeQueries?.townOnly) {
          const townUrl = this.generateNominatimUrl(alternativeQueries.townOnly);
          const townResp = await fetch(townUrl);
          alternativeResults['town'] = await townResp.json();
        }
        
        if (alternativeQueries?.neighbourhoodOnly) {
          const neighborhoodUrl = this.generateNominatimUrl(alternativeQueries.neighbourhoodOnly);
          const neighborhoodResp = await fetch(neighborhoodUrl);
          alternativeResults['neighborhood'] = await neighborhoodResp.json();
        }
      }
      
      return new Response(JSON.stringify({
        original: query,
        corrected: correctionResult.correctedAddress,
        corrections: correctionResult.corrections,
        confidence: correctionResult.confidence,
        formatted: formattedAddress,
        results: data,
        alternativeResults: Object.keys(alternativeResults).length > 0 ? alternativeResults : undefined
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Error fetching from Nominatim:', error);
      return new Response(JSON.stringify({ error: 'Failed to fetch from Nominatim' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  // Get agent stats
  async getStats(): Promise<Response> {
    return new Response(JSON.stringify({
      stats: this.state.correctionStats,
      recentAddresses: this.state.processedAddresses.slice(-10) // Return only the 10 most recent
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Create the Hono app for routing
const app = new Hono<{ Bindings: Env }>();

// Add CORS middleware
app.use('*', cors());

// Main route handler that directs requests to the Agent or fallback
app.all('*', async (c) => {
  // Try to route to agent
  const agentResponse = await routeAgentRequest(c.req.raw, c.env);
  
  if (agentResponse) {
    return agentResponse;
  }
  
  // Fallback for non-agent routes
  return c.text('Nominatim Address Formatter API - Use /format-address or /search endpoints', 404);
});

export default app;