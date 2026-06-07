/**
 * 全局常量与配置
 */

// 音频采集参数
export const TARGET_SAMPLE_RATE = 16000; // 千问 API 要求的采样率
export const BUFFER_SIZE = 4096;         // ScriptProcessor 缓冲区大小 (2的幂次方)

// 字号设置
export const MIN_FONT_SIZE = 12;
export const MAX_FONT_SIZE = 24;

// 语言数据
export const LANG_DATA = [
    { code: "zh", name: "中文", native: "中文" },
    { code: "en", name: "英语", native: "English" },
    { code: "ja", name: "日语", native: "日本語" },
    { code: "ko", name: "韩语", native: "한국어" },
    { code: "fr", name: "法语", native: "Français" },
    { code: "de", name: "德语", native: "Deutsch" },
    { code: "es", name: "西班牙语", native: "Español" },
    { code: "pt", name: "葡萄牙语", native: "Português" },
    { code: "ru", name: "俄语", native: "русский" },
    { code: "ar", name: "阿拉伯语", native: "العربية" },
    { code: "it", name: "意大利语", native: "Italiano" },
    { code: "id", name: "印尼语", native: "Bahasa Indonesia" },
    { code: "vi", name: "越南语", native: "Tiếng Việt" },
    { code: "th", name: "泰语", native: "ไทย" },
    { code: "tr", name: "土耳其语", native: "Türkçe" },
    { code: "hi", name: "印地语", native: "हिन्दी" },
    { code: "ms", name: "马来语", native: "Bahasa Melayu" },
    { code: "nl", name: "荷兰语", native: "Nederlands" },
    { code: "ur", name: "乌尔都语", native: "اردو" },
    { code: "nb", name: "挪威语", native: "Norsk" },
    { code: "sv", name: "瑞典语", native: "Svenska" },
    { code: "da", name: "丹麦语", native: "Dansk" },
    { code: "he", name: "希伯来语", native: "עברית" },
    { code: "fi", name: "芬兰语", native: "Suomi" },
    { code: "pl", name: "波兰语", native: "Polski" },
    { code: "is", name: "冰岛语", native: "Íslenska" },
    { code: "cs", name: "捷克语", native: "Čeština" },
    { code: "fil", name: "菲律宾语", native: "Filipino" },
    { code: "fa", name: "波斯语", native: "فارسی" },
    { code: "yue", name: "粤语", native: "粵語" },
    { code: "el", name: "希腊语", native: "Ελληνικά" },
    { code: "af", name: "南非荷兰语", native: "Afrikaans" },
    { code: "ast", name: "阿斯图里亚斯语", native: "Asturianu" },
    { code: "be", name: "白俄罗斯语", native: "Беларуская" },
    { code: "bg", name: "保加利亚语", native: "Български" },
    { code: "bn", name: "孟加拉语", native: "বাংলা" },
    { code: "bs", name: "波斯尼亚语", native: "Bosanski" },
    { code: "ca", name: "加泰罗尼亚语", native: "Català" },
    { code: "ceb", name: "宿务语", native: "Cebuano" },
    { code: "et", name: "爱沙尼亚语", native: "Eesti" },
    { code: "gl", name: "加利西亚语", native: "Galego" },
    { code: "gu", name: "古吉拉特语", native: "ગુજરાતી" },
    { code: "hr", name: "克罗地亚语", native: "Hrvatski" },
    { code: "hu", name: "匈牙利语", native: "Magyar" },
    { code: "jv", name: "爪哇语", native: "Basa Jawa" },
    { code: "kk", name: "哈萨克语", native: "Қазақша" },
    { code: "kn", name: "卡纳达语", native: "ಕನ್ನಡ" },
    { code: "ky", name: "柯尔克孜语", native: "Кыргызча" },
    { code: "lv", name: "拉脱维亚语", native: "Latviešu" },
    { code: "mk", name: "马其顿语", native: "Македонски" },
    { code: "ml", name: "马拉雅拉姆语", native: "മലയാളം" },
    { code: "mr", name: "马拉地语", native: "मराठी" },
    { code: "pa", name: "旁遮普语", native: "ਪੰਜਾਬੀ" },
    { code: "ro", name: "罗马尼亚语", native: "Română" },
    { code: "sk", name: "斯洛伐克语", native: "Slovenčina" },
    { code: "sl", name: "斯洛文尼亚语", native: "Slovenščina" },
    { code: "sw", name: "斯瓦希里语", native: "Kiswahili" },
    { code: "tg", name: "塔吉克语", native: "Тоҷикӣ" },
    { code: "az", name: "阿塞拜疆语", native: "Azərbaycanca" },
    { code: "uk", name: "乌克兰语", native: "Українська" },
];
