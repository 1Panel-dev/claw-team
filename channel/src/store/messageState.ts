/**
 * 这个文件负责消息状态记录。
 * 目前先用内存实现，目的是让联调和排障时能看清每条消息走到了哪一步。
 */
import type { MessageStage, MessageStateRecord, RoutingMode } from "../types.js";

export interface MessageStateStore {
    create(record: MessageStateRecord): void;
    update(
        messageId: string,
        patch: Partial<Omit<MessageStateRecord, "messageId" | "createdAt" | "lastUpdated">> & {
            status: MessageStage;
            routingMode?: RoutingMode;
        },
    ): MessageStateRecord;
    get(messageId: string): MessageStateRecord | undefined;
    // list 主要给调试接口或后续管理页面使用。
    list(): MessageStateRecord[];
}

export class InMemoryMessageStateStore implements MessageStateStore {
    private readonly records = new Map<string, MessageStateRecord>();

    create(record: MessageStateRecord): void {
        this.records.set(record.messageId, record);
    }

    update(
        messageId: string,
        patch: Partial<Omit<MessageStateRecord, "messageId" | "createdAt" | "lastUpdated">> & {
            status: MessageStage;
            routingMode?: RoutingMode;
        },
    ): MessageStateRecord {
        const current = this.records.get(messageId);
        if (!current) {
            throw new Error(`message state not found: ${messageId}`);
        }

        // 每次更新都会自动刷新 lastUpdated，调用方不需要自己管时间戳。
        const next: MessageStateRecord = {
            ...current,
            ...patch,
            lastUpdated: new Date().toISOString(),
        };
        this.records.set(messageId, next);
        return next;
    }

    get(messageId: string): MessageStateRecord | undefined {
        return this.records.get(messageId);
    }

    list(): MessageStateRecord[] {
        return Array.from(this.records.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
}
