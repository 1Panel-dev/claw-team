import { defineStore } from "pinia";

import { fetchAddressBook } from "@/api/addressBook";
import { fetchConversationList } from "@/api/conversations";
import { fetchMockAddressBook, fetchMockConversationList, isMessageMockEnabled } from "@/mocks/messageWorkbench";
import type { AddressBookResponseApi } from "@/types/api/addressBook";
import type { ConversationListItemApi } from "@/types/api/conversation";

const HIDDEN_RECENT_STORAGE_KEY = "clawswarm:hidden-recent-conversations";

type HiddenRecentConversationEntry = {
    hidden_at: string;
    last_message_id: string | null;
};

type HiddenRecentConversationMap = Record<string, HiddenRecentConversationEntry>;

export const useAddressBookStore = defineStore("addressBook", {
    state: () => ({
        loading: false,
        recentLoading: false,
        addressBook: null as AddressBookResponseApi | null,
        recentConversations: [] as ConversationListItemApi[],
        hiddenRecentConversationMap: loadHiddenRecentConversationMap(),
    }),
    getters: {
        instances: (state) => state.addressBook?.instances ?? [],
        groups: (state) => state.addressBook?.groups ?? [],
        visibleRecentConversations: (state) =>
            state.recentConversations.filter((item) => {
                const hiddenEntry = state.hiddenRecentConversationMap[String(item.id)];
                if (!hiddenEntry) {
                    return true;
                }
                return item.last_message_id !== hiddenEntry.last_message_id;
            }),
    },
    actions: {
        async loadAddressBook() {
            this.loading = true;
            try {
                this.addressBook = isMessageMockEnabled() ? await fetchMockAddressBook() : await fetchAddressBook();
            } finally {
                this.loading = false;
            }
        },
        async loadRecentConversations() {
            this.recentLoading = true;
            try {
                this.recentConversations = isMessageMockEnabled()
                    ? await fetchMockConversationList()
                    : await fetchConversationList();
                this.reconcileHiddenRecentConversations();
            } finally {
                this.recentLoading = false;
            }
        },
        async loadAll() {
            this.loading = true;
            try {
                const [addressBook, recentConversations] = isMessageMockEnabled()
                    ? await Promise.all([fetchMockAddressBook(), fetchMockConversationList()])
                    : await Promise.all([fetchAddressBook(), fetchConversationList()]);
                this.addressBook = addressBook;
                this.recentConversations = recentConversations;
                this.reconcileHiddenRecentConversations();
            } finally {
                this.loading = false;
            }
        },
        async refreshRecentConversations() {
            this.recentConversations = isMessageMockEnabled()
                ? await fetchMockConversationList()
                : await fetchConversationList();
            this.reconcileHiddenRecentConversations();
        },
        hideRecentConversation(conversationId: number) {
            const currentConversation = this.recentConversations.find((item) => item.id === conversationId);
            this.hiddenRecentConversationMap = {
                ...this.hiddenRecentConversationMap,
                [String(conversationId)]: {
                    hidden_at: new Date().toISOString(),
                    last_message_id: currentConversation?.last_message_id ?? null,
                },
            };
            persistHiddenRecentConversationMap(this.hiddenRecentConversationMap);
        },
        reconcileHiddenRecentConversations() {
            let changed = false;
            const nextMap: HiddenRecentConversationMap = { ...this.hiddenRecentConversationMap };
            for (const item of this.recentConversations) {
                const key = String(item.id);
                const hiddenEntry = nextMap[key];
                if (!hiddenEntry) {
                    continue;
                }
                // 最近联系人只是在当前消息快照下暂时隐藏。
                // 只要最后一条消息变了，就说明这条会话重新活跃，应当自动回到列表中。
                if (item.last_message_id !== hiddenEntry.last_message_id) {
                    delete nextMap[key];
                    changed = true;
                }
            }
            if (!changed) {
                return;
            }
            this.hiddenRecentConversationMap = nextMap;
            persistHiddenRecentConversationMap(this.hiddenRecentConversationMap);
        },
    },
});

function loadHiddenRecentConversationMap(): HiddenRecentConversationMap {
    if (typeof window === "undefined") {
        return {};
    }
    try {
        const raw = window.localStorage.getItem(HIDDEN_RECENT_STORAGE_KEY);
        if (!raw) {
            return {};
        }
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return {};
        }
        return normalizeHiddenRecentConversationMap(parsed as Record<string, unknown>);
    } catch {
        return {};
    }
}

function persistHiddenRecentConversationMap(value: HiddenRecentConversationMap) {
    if (typeof window === "undefined") {
        return;
    }
    window.localStorage.setItem(HIDDEN_RECENT_STORAGE_KEY, JSON.stringify(value));
}

function normalizeHiddenRecentConversationMap(value: Record<string, unknown>): HiddenRecentConversationMap {
    const entries = Object.entries(value).flatMap(([conversationId, rawEntry]) => {
        if (typeof rawEntry === "string") {
            // 兼容旧格式：以前只记录隐藏时间。
            return [[conversationId, { hidden_at: rawEntry, last_message_id: null } satisfies HiddenRecentConversationEntry] as const];
        }
        if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
            return [];
        }
        const hiddenAt =
            typeof (rawEntry as { hidden_at?: unknown }).hidden_at === "string"
                ? (rawEntry as { hidden_at: string }).hidden_at
                : null;
        const lastMessageId = (rawEntry as { last_message_id?: unknown }).last_message_id;
        if (!hiddenAt) {
            return [];
        }
        return [[
            conversationId,
            {
                hidden_at: hiddenAt,
                last_message_id: typeof lastMessageId === "string" ? lastMessageId : null,
            } satisfies HiddenRecentConversationEntry,
        ] as const];
    });
    return Object.fromEntries(entries);
}
