import ReactMarkdown from 'react-markdown'
import AttachmentChips from '../AttachmentChips'
import { contentToText } from '../../utils/attachmentStore'

/**
 * Render one chat message bubble's inner content. Shared by ChatPage (App
 * Builder planning chat) and BialChatPage (general assistant) — the ReactMarkdown
 * variant. (BuilderPage keeps its own MessageContent: it strips jsx:preview code
 * fences, a different behaviour, so it is NOT a consumer of this module.)
 *
 * `content` may be a string OR a ContentBlock[] (attachment turn); contentToText
 * always derives plain text so react-markdown / the user div never receives an
 * array and renders "[object Object]".
 */
export default function MessageContent({ content, attachments, isUser }) {
  const text = contentToText(content)
  return (
    <>
      {attachments?.length > 0 && <AttachmentChips attachments={attachments} />}
      {isUser ? (
        <div className="whitespace-pre-wrap break-words">{text}</div>
      ) : (
        <div className="prose prose-sm max-w-none prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-strong:text-tertiary prose-ul:pl-4 prose-ol:pl-4">
          <ReactMarkdown>{text}</ReactMarkdown>
        </div>
      )}
    </>
  )
}
