/**
 * lib/contact-i18n.ts — Bilingual (EN / VI) copy & validation helpers
 * ────────────────────────────────────────────────────────────────────
 * Follows the existing lib/locales.ts convention without introducing any
 * external i18n dependency. Safe for both Server and Client Components.
 */

import { DEFAULT_LOCALE, normalizeLocale, type SupportedLocale } from './locales'

export const CONTACT_SUBJECT_KEYS = [
  'servicenow-question',
  'article-correction',
  'website-feedback',
  'topic-suggestion',
  'other',
] as const

export type ContactSubjectKey = (typeof CONTACT_SUBJECT_KEYS)[number]

// Canonical English labels used when sending subjects to Formspree
export const FORMSPREE_SUBJECT_LABELS: Record<ContactSubjectKey, string> = {
  'servicenow-question': 'ServiceNow Question',
  'article-correction': 'Article Correction',
  'website-feedback': 'Website Feedback',
  'topic-suggestion': 'Topic Suggestion',
  other: 'Other',
}

export const FIELD_LIMITS = {
  nameMax: 100,
  emailMax: 254,
  articleTitleMax: 200,
  articleUrlMax: 2048,
  messageMin: 10,
  messageMax: 5000,
} as const

export interface ContactCopy {
  eyebrow: string
  title: string
  description: string
  languageLabel: string
  formUnavailableTitle: string
  formUnavailableBody: string
  fields: {
    name: {
      label: string
      optional: string
      placeholder: string
    }
    email: {
      label: string
      required: string
      placeholder: string
    }
    subject: {
      label: string
      required: string
      placeholder: string
      options: Record<ContactSubjectKey, string>
    }
    relatedArticle: {
      sectionLabel: string
      optional: string
      titleLabel: string
      titlePlaceholder: string
      urlLabel: string
      urlPlaceholder: string
      prefilledNote: string
      clearButton: string
    }
    message: {
      label: string
      required: string
      placeholder: string
      hint: string
    }
  }
  privacyNotice: string
  submit: string
  submitting: string
  successTitle: string
  successBody: string
  sendAnother: string
  backHome: string
  errors: {
    nameMax: string
    emailRequired: string
    emailInvalid: string
    emailMax: string
    subjectRequired: string
    articleTitleMax: string
    articleUrlInvalid: string
    articleUrlMax: string
    messageRequired: string
    messageMin: string
    messageMax: string
    formUnavailable: string
    submitFailed: string
    rateLimited: string
    networkError: string
  }
  articleFeedback: {
    heading: string
    description: string
    button: string
  }
}

const CONTACT_COPY: Record<SupportedLocale, ContactCopy> = {
  en: {
    eyebrow: 'Contact & Feedback',
    title: "Let's Connect",
    description:
      "Have a question about ServiceNow, found something incorrect, or simply want to share an idea? I'd love to hear from you.",
    languageLabel: 'Language',
    formUnavailableTitle: 'Contact form is currently unavailable',
    formUnavailableBody:
      'Form submission is not configured yet. Please set NEXT_PUBLIC_FORMSPREE_FORM_ID in your environment variables to enable messages.',
    fields: {
      name: {
        label: 'Name',
        optional: 'Optional',
        placeholder: 'Your name',
      },
      email: {
        label: 'Email',
        required: 'Required',
        placeholder: 'you@example.com',
      },
      subject: {
        label: 'Subject',
        required: 'Required',
        placeholder: 'Select a topic',
        options: {
          'servicenow-question': 'ServiceNow Question',
          'article-correction': 'Article Correction',
          'website-feedback': 'Website Feedback',
          'topic-suggestion': 'Topic Suggestion',
          other: 'Other',
        },
      },
      relatedArticle: {
        sectionLabel: 'Related Article',
        optional: 'Optional',
        titleLabel: 'Article Title',
        titlePlaceholder: 'e.g. Exporting Large Datasets in ServiceNow',
        urlLabel: 'Article URL',
        urlPlaceholder: 'https://servicenow-space.vercel.app/...',
        prefilledNote: 'Pre-filled from the article you were reading. You can edit or clear these fields.',
        clearButton: 'Clear',
      },
      message: {
        label: 'Message',
        required: 'Required',
        placeholder:
          'Share your ServiceNow question, describe the correction, or tell us how we can improve…',
        hint: 'Minimum 10 characters.',
      },
    },
    privacyNotice:
      'Privacy note: Your message is transmitted over HTTPS via Formspree and forwarded directly to the author. No account is required, and messages are not stored in this website’s database.',
    submit: 'Send Message',
    submitting: 'Sending…',
    successTitle: 'Message sent — thank you',
    successBody:
      'Your note has been delivered. Thank you for taking the time to reach out and help improve ServiceNow Knowledge Hub.',
    sendAnother: 'Send another message',
    backHome: 'Back to Knowledge Hub',
    errors: {
      nameMax: 'Name must be 100 characters or fewer.',
      emailRequired: 'Please enter your email address.',
      emailInvalid: 'Please enter a valid email address.',
      emailMax: 'Email address must be 254 characters or fewer.',
      subjectRequired: 'Please choose a subject.',
      articleTitleMax: 'Article title must be 200 characters or fewer.',
      articleUrlInvalid: 'Please enter a valid http:// or https:// URL.',
      articleUrlMax: 'Article URL is too long.',
      messageRequired: 'Please enter a message.',
      messageMin: 'Message must be at least 10 characters.',
      messageMax: 'Message must be 5,000 characters or fewer.',
      formUnavailable:
        'The contact form is not configured yet and cannot send messages right now.',
      submitFailed:
        'We could not send your message right now. Your input has been preserved — please try again in a moment.',
      rateLimited:
        'Too many submissions in a short time. Please wait a moment and try again.',
      networkError:
        'Network error while sending your message. Please check your connection and try again.',
    },
    articleFeedback: {
      heading: 'Found something incorrect?',
      description:
        'Help improve this article by suggesting a correction or sharing your feedback.',
      button: 'Suggest a Correction',
    },
  },
  vi: {
    eyebrow: 'Liên hệ & Góp ý',
    title: 'Kết nối & Góp ý',
    description:
      'Bạn có câu hỏi về ServiceNow, phát hiện nội dung chưa chính xác, hay muốn chia sẻ một ý tưởng? Tôi rất mong nhận được phản hồi từ bạn.',
    languageLabel: 'Ngôn ngữ',
    formUnavailableTitle: 'Biểu mẫu liên hệ hiện chưa khả dụng',
    formUnavailableBody:
      'Chức năng gửi biểu mẫu chưa được cấu hình. Vui lòng thiết lập biến môi trường NEXT_PUBLIC_FORMSPREE_FORM_ID để kích hoạt.',
    fields: {
      name: {
        label: 'Họ và tên',
        optional: 'Không bắt buộc',
        placeholder: 'Tên của bạn',
      },
      email: {
        label: 'Email',
        required: 'Bắt buộc',
        placeholder: 'ban@example.com',
      },
      subject: {
        label: 'Chủ đề',
        required: 'Bắt buộc',
        placeholder: 'Chọn chủ đề',
        options: {
          'servicenow-question': 'Câu hỏi về ServiceNow',
          'article-correction': 'Đề xuất chỉnh sửa bài viết',
          'website-feedback': 'Góp ý về website',
          'topic-suggestion': 'Đề xuất chủ đề mới',
          other: 'Khác',
        },
      },
      relatedArticle: {
        sectionLabel: 'Bài viết liên quan',
        optional: 'Không bắt buộc',
        titleLabel: 'Tiêu đề bài viết',
        titlePlaceholder: 'VD: Xuất tập dữ liệu lớn trong ServiceNow',
        urlLabel: 'Đường dẫn bài viết (URL)',
        urlPlaceholder: 'https://servicenow-space.vercel.app/...',
        prefilledNote:
          'Được điền sẵn từ bài viết bạn vừa đọc. Bạn có thể chỉnh sửa hoặc xóa nếu muốn.',
        clearButton: 'Xóa',
      },
      message: {
        label: 'Nội dung',
        required: 'Bắt buộc',
        placeholder:
          'Chia sẻ câu hỏi về ServiceNow, mô tả nội dung cần chỉnh sửa, hoặc góp ý của bạn…',
        hint: 'Tối thiểu 10 ký tự.',
      },
    },
    privacyNotice:
      'Lưu ý quyền riêng tư: Nội dung của bạn được gửi qua HTTPS thông qua Formspree và chuyển thẳng đến tác giả. Không cần đăng nhập và tin nhắn không được lưu trong cơ sở dữ liệu của website này.',
    submit: 'Gửi tin nhắn',
    submitting: 'Đang gửi…',
    successTitle: 'Đã gửi tin nhắn — cảm ơn bạn',
    successBody:
      'Phản hồi của bạn đã được chuyển đi. Cảm ơn bạn đã dành thời gian đóng góp để giúp ServiceNow Knowledge Hub ngày càng tốt hơn.',
    sendAnother: 'Gửi tin nhắn khác',
    backHome: 'Quay lại trang chủ',
    errors: {
      nameMax: 'Tên không được vượt quá 100 ký tự.',
      emailRequired: 'Vui lòng nhập địa chỉ email của bạn.',
      emailInvalid: 'Vui lòng nhập một địa chỉ email hợp lệ.',
      emailMax: 'Địa chỉ email không được vượt quá 254 ký tự.',
      subjectRequired: 'Vui lòng chọn một chủ đề.',
      articleTitleMax: 'Tiêu đề bài viết không được vượt quá 200 ký tự.',
      articleUrlInvalid: 'Vui lòng nhập đường dẫn http:// hoặc https:// hợp lệ.',
      articleUrlMax: 'Đường dẫn bài viết quá dài.',
      messageRequired: 'Vui lòng nhập nội dung tin nhắn.',
      messageMin: 'Nội dung cần có ít nhất 10 ký tự.',
      messageMax: 'Nội dung không được vượt quá 5.000 ký tự.',
      formUnavailable:
        'Biểu mẫu liên hệ chưa được cấu hình nên hiện chưa thể gửi tin nhắn.',
      submitFailed:
        'Không thể gửi tin nhắn vào lúc này. Nội dung bạn đã nhập vẫn được giữ nguyên — vui lòng thử lại sau ít phút.',
      rateLimited:
        'Bạn đã gửi quá nhiều yêu cầu trong thời gian ngắn. Vui lòng đợi một lát rồi thử lại.',
      networkError:
        'Lỗi kết nối mạng khi gửi tin nhắn. Vui lòng kiểm tra kết nối và thử lại.',
    },
    articleFeedback: {
      heading: 'Phát hiện nội dung chưa chính xác?',
      description:
        'Giúp cải thiện bài viết này bằng cách đề xuất chỉnh sửa hoặc chia sẻ góp ý của bạn.',
      button: 'Đề xuất chỉnh sửa',
    },
  },
}

/**
 * Resolves a supported contact UI locale ('en' | 'vi'), falling back to 'en'.
 */
export function resolveContactLocale(rawLocale: unknown): SupportedLocale {
  const normalized = normalizeLocale(rawLocale)
  if (normalized === 'en' || normalized === 'vi') {
    return normalized
  }
  return DEFAULT_LOCALE
}

export function getContactCopy(rawLocale: unknown): ContactCopy {
  return CONTACT_COPY[resolveContactLocale(rawLocale)]
}

/**
 * Validates that a supplied URL is a safe, well-formed http(s) URL.
 */
export function isValidHttpUrl(rawUrl: unknown): boolean {
  if (typeof rawUrl !== 'string') return false
  const trimmed = rawUrl.trim()
  if (!trimmed || trimmed.length > FIELD_LIMITS.articleUrlMax) return false
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Validates a standard email format within RFC max length (254 chars).
 */
export function isValidEmail(rawEmail: unknown): boolean {
  if (typeof rawEmail !== 'string') return false
  const trimmed = rawEmail.trim()
  if (!trimmed || trimmed.length > FIELD_LIMITS.emailMax) return false
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed)
}

/**
 * Strips ASCII control characters and clamps a query string value safely.
 */
export function sanitizeTextParam(rawValue: unknown, maxLength: number): string {
  if (typeof rawValue !== 'string') return ''
  return rawValue
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

/**
 * Normalizes a subject query parameter into one of CONTACT_SUBJECT_KEYS.
 */
export function resolveSubjectParam(rawSubject: unknown): ContactSubjectKey | '' {
  if (typeof rawSubject !== 'string') return ''
  const normalized = rawSubject.trim().toLowerCase()
  if ((CONTACT_SUBJECT_KEYS as readonly string[]).includes(normalized)) {
    return normalized as ContactSubjectKey
  }
  if (normalized === 'article correction') return 'article-correction'
  if (normalized === 'servicenow question') return 'servicenow-question'
  if (normalized === 'website feedback') return 'website-feedback'
  if (normalized === 'topic suggestion') return 'topic-suggestion'
  return ''
}

/**
 * Validates that a Formspree form ID contains only safe URL path characters.
 */
export function isValidFormspreeId(rawId: unknown): boolean {
  if (typeof rawId !== 'string') return false
  const trimmed = rawId.trim()
  return /^[a-zA-Z0-9_-]{4,64}$/.test(trimmed)
}
