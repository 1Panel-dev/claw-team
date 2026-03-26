import projectManagerIdentity from "@/agent-templates/project-manager/IDENTITY.md?raw";
import projectManagerSoul from "@/agent-templates/project-manager/SOUL.md?raw";
import projectManagerMemory from "@/agent-templates/project-manager/MEMORY.md?raw";
import executionEngineerIdentity from "@/agent-templates/execution-engineer/IDENTITY.md?raw";
import executionEngineerSoul from "@/agent-templates/execution-engineer/SOUL.md?raw";
import executionEngineerMemory from "@/agent-templates/execution-engineer/MEMORY.md?raw";

export type AgentTemplateDefinition = {
    key: string;
    labelKey: string;
    agent_key: string;
    display_name: string;
    role_name: string;
    identity_md: string;
    soul_md: string;
    user_md: string;
    memory_md: string;
};

export const AGENT_TEMPLATES: AgentTemplateDefinition[] = [
    {
        key: "blank",
        labelKey: "openclaw.agentTemplateBlank",
        agent_key: "",
        display_name: "",
        role_name: "",
        identity_md: "",
        soul_md: "",
        user_md: "",
        memory_md: "",
    },
    {
        key: "project-manager",
        labelKey: "openclaw.agentTemplateProjectManager",
        agent_key: "project-manager",
        display_name: "项目经理",
        role_name: "项目经理",
        identity_md: projectManagerIdentity,
        soul_md: projectManagerSoul,
        user_md: "",
        memory_md: projectManagerMemory,
    },
    {
        key: "execution-engineer",
        labelKey: "openclaw.agentTemplateExecutionEngineer",
        agent_key: "execution-engineer",
        display_name: "执行工程师",
        role_name: "执行工程师",
        identity_md: executionEngineerIdentity,
        soul_md: executionEngineerSoul,
        user_md: "",
        memory_md: executionEngineerMemory,
    },
];
