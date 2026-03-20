export interface OllamaStatus {
  available: boolean;
  running: boolean;
  models: string[];
}

export class OllamaControl {
  private managerUrl = 'http://localhost:5182';

  async getStatus(): Promise<OllamaStatus> {
    try {
      const res = await fetch(`${this.managerUrl}/status`);
      if (!res.ok) throw new Error('Manager unreachable');
      return await res.json();
    } catch {
      return { available: false, running: false, models: [] };
    }
  }

  async startOllama(): Promise<{ success: boolean; message: string }> {
    try {
      const res = await fetch(`${this.managerUrl}/start`, { method: 'POST' });
      const data = await res.json();

      if (!res.ok) {
        return { success: false, message: data.error || 'Failed to start Ollama' };
      }

      return { success: true, message: `Ollama started (PID: ${data.pid})` };
    } catch (err) {
      return {
        success: false,
        message: `Manager error: ${(err as Error).message}. Make sure "npm run serve:ollama" is running.`,
      };
    }
  }

  async stopOllama(): Promise<{ success: boolean; message: string }> {
    try {
      const res = await fetch(`${this.managerUrl}/stop`, { method: 'POST' });
      const data = await res.json();

      if (!res.ok) {
        return { success: false, message: data.error || 'Failed to stop Ollama' };
      }

      return { success: true, message: 'Ollama stopped' };
    } catch (err) {
      return { success: false, message: (err as Error).message };
    }
  }
}
