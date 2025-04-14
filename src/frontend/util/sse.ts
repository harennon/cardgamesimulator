export class EventSourceSingleton {
    private static INSTANCE: EventSourceSingleton;

    private readonly eventSource: EventSource;
    private constructor() {
        this.eventSource = new EventSource('/api/event', { withCredentials: true });
    }

    public static getInstance(): EventSourceSingleton {
        // First time initializing or error while initializing previously
        if (!EventSourceSingleton.INSTANCE || EventSourceSingleton.INSTANCE.eventSource.readyState === EventSource.CLOSED) {
            EventSourceSingleton.INSTANCE = new EventSourceSingleton();
        }
        return EventSourceSingleton.INSTANCE;
    }

    public getEventSource(): EventSource {
        return this.eventSource;
    }
}