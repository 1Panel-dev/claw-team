/**
 * 会话传输层。
 *
 * 优先使用 WebSocket 感知消息变化；不可用时回退到定时轮询。
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";

import { resolveWebSocketBaseUrl } from "@/api/baseUrl";
import { useAddressBookStore } from "@/stores/addressBook";
import { useConversationStore } from "@/stores/conversation";

function resolveWebSocketUrl() {
    const transport = import.meta.env.VITE_MESSAGE_TRANSPORT ?? "websocket";
    return {
        enabled: transport === "websocket",
        baseUrl: resolveWebSocketBaseUrl(),
    };
}

export function useConversationTransport() {
    const conversationStore = useConversationStore();
    const addressBookStore = useAddressBookStore();
    const timer = ref<number | null>(null);
    const socket = ref<WebSocket | null>(null);
    const mode = ref<"websocket" | "polling">("polling");
    const currentConversationId = computed(() => conversationStore.currentConversationId);

    async function syncConversation() {
        if (!conversationStore.currentConversationId) {
            return;
        }
        await conversationStore.pollCurrentConversation();
        await addressBookStore.refreshRecentConversations();
    }

    function startPolling(intervalMs = 2500) {
        stopPolling();
        mode.value = "polling";
        timer.value = window.setInterval(() => {
            void syncConversation();
        }, intervalMs);
    }

    function stopPolling() {
        if (timer.value !== null) {
            window.clearInterval(timer.value);
            timer.value = null;
        }
    }

    function closeSocket() {
        if (socket.value) {
            socket.value.close();
            socket.value = null;
        }
    }

    function connectWebSocket(conversationId: number) {
        const { enabled, baseUrl } = resolveWebSocketUrl();
        if (!enabled) {
            startPolling();
            return;
        }

        closeSocket()
        stopPolling();

        const ws = new WebSocket(`${baseUrl}/ws/conversations/${conversationId}`);
        socket.value = ws;

        ws.onopen = () => {
            mode.value = "websocket";
        };

        ws.onmessage = () => {
            void syncConversation();
        };

        ws.onerror = () => {
            if (socket.value === ws) {
                closeSocket();
                startPolling();
            }
        };

        ws.onclose = () => {
            if (socket.value === ws) {
                socket.value = null;
                startPolling();
            }
        };
    }

    watch(
        currentConversationId,
        (conversationId) => {
            if (!conversationId) {
                closeSocket();
                stopPolling();
                return;
            }
            connectWebSocket(conversationId);
        },
        { immediate: true },
    );

    onBeforeUnmount(() => {
        closeSocket();
        stopPolling();
    });

    return {
        mode,
        startPolling,
        stopPolling,
    };
}
