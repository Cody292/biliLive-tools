import showInput from "@renderer/components/showInput";

export async function verifyBiliKey(): Promise<boolean> {
  if (!window.isWeb) {
    return true;
  }

  const configuredKey = import.meta.env.VITE_BILILIVE_TOOLS_BILIKEY;
  if (!configuredKey) {
    window.alert("未配置 BILILIVE_TOOLS_BILIKEY，当前操作已拦截");
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
    return false;
  }

  return userInput.trim() === configuredKey;
}
