import Link from 'next/link'
import { requireStudyPageSession } from '../../../lib/study/auth/guard'
import { createNotionStudyRepositories } from '../../../lib/study/repositories'
import type { ExamCollection } from '../../../lib/study/types'
import StudyNav from '../../../components/study/StudyNav'

export const dynamic = 'force-dynamic'

export default async function StudyExamsPage() {
  const user = await requireStudyPageSession({ returnTo: '/study/exams' })

  let exams: ExamCollection[] = []
  try {
    const repos = createNotionStudyRepositories()
    exams = await repos.exams.list({ status: 'published' })
  } catch {
    exams = []
  }

  return (
    <>
      <StudyNav user={user} />
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10 space-y-6">
        <div>
          <h1 className="font-serif text-2xl sm:text-3xl font-medium text-ink-700 dark:text-sage-100 m-0">
            CSA Mock Exams
          </h1>
          <p className="text-[0.9rem] text-ink-500 dark:text-sage-400 mt-1.5 mb-0">
            Timed simulations with server-side grading, no mid-exam answer reveals, and full post-exam explanations.
          </p>
        </div>

        {exams.length === 0 ? (
          <div className="rounded-card p-8 text-center bg-rice-paper-50/80 dark:bg-tea-slate-200/50 border border-rice-paper-400/60 dark:border-tea-slate-50/40 text-sm text-ink-400 dark:text-sage-500">
            No published exam collections found yet.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {exams.map((exam) => (
              <div
                key={exam.examId}
                className="rounded-card p-6 bg-rice-paper-50/90 dark:bg-tea-slate-200/65 border border-rice-paper-400/70 dark:border-tea-slate-50/50 shadow-zen-sm flex flex-col justify-between gap-4"
              >
                <div>
                  <span className="text-[0.68rem] uppercase tracking-[0.18em] text-matcha-600 dark:text-matcha-400 font-medium">
                    {exam.certificationCategory} · {exam.questionCount} questions
                  </span>
                  <h2 className="font-serif text-lg font-medium text-ink-700 dark:text-sage-100 mt-1 mb-1.5">
                    {exam.title}
                  </h2>
                  {exam.description && (
                    <p className="text-[0.84rem] text-ink-500 dark:text-sage-400 m-0">
                      {exam.description}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-3 pt-2 border-t border-rice-paper-400/50 dark:border-tea-slate-50/40">
                  <Link
                    href={`/study/exams/${encodeURIComponent(exam.examId)}`}
                    className="px-4 py-2 rounded-zen text-xs font-medium bg-matcha-500 hover:bg-matcha-600 text-white no-underline transition-colors duration-200 motion-reduce:transition-none"
                  >
                    Start Timed Exam
                  </Link>
                  <Link
                    href={`/study/practice?examId=${encodeURIComponent(exam.examId)}`}
                    className="text-xs text-ink-600 dark:text-sage-300 hover:underline no-underline"
                  >
                    Practice Instead
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
