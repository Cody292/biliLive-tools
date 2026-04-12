import showInput from "@renderer/components/showInput";

export type VerifyBiliKeyBlockedReason = "missing" | "mismatch" | "cancelled";

interface VerifyBiliKeyOptions {
  onBlocked?: (reason: VerifyBiliKeyBlockedReason) => void;
}

export async function verifyBiliKey(options?: VerifyBiliKeyOptions): Promise<boolean> {
  if (!window.isWeb) {
    return true;
  }

  const viteKey = import.meta.env.VITE_BILILIVE_TOOLS_BILIKEY;
  const directKey = Reflect.get(import.meta.env, "BILILIVE_TOOLS_BILIKEY");
  const configuredKey = (
    typeof viteKey === "string"
      ? viteKey
      : typeof directKey === "string"
        ? directKey
        : ""
  ).trim();

  if (!configuredKey) {
    options?.onBlocked?.("missing");
    return false;
  }

  const userInput = await showInput({
    title: "安全校验",
    placeholder: "请输入 BILILIVE_TOOLS_BILIKEY",
    type: "password",
    required: true,
    errorMessage: "请输入密钥",
  });

  if (typeof userInput !== "string") {
    options?.onBlocked?.("cancelled");
    return false;
  }

  const isMatched = userInput.trim() === configuredKey;
  if (!isMatched) {
    options?.onBlocked?.("mismatch");
  }
  return isMatched;
}
