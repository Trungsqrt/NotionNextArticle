/**
 * lib/study/repositories/index.ts — Study System repository bundle factory
 */

import { getStudyNotionConfig, type StudyNotionConfig } from '../config'
import { getDefaultStudyNotionClient, type StudyNotionClient } from '../notion-client'
import type {
  StudyUserRepository,
  ExamCollectionRepository,
  QuestionBankRepository,
  FsrsCardStateRepository,
  ReviewEventRepository,
  StudyBookmarkRepository,
} from './interfaces'
import { createNotionStudyUserRepository } from './user-repo'
import { createNotionExamCollectionRepository } from './exam-repo'
import { createNotionQuestionBankRepository } from './question-repo'
import { createNotionFsrsCardStateRepository } from './card-state-repo'
import { createNotionReviewEventRepository } from './review-event-repo'
import { createNotionStudyBookmarkRepository } from './bookmark-repo'

export interface StudyRepositories {
  users: StudyUserRepository
  exams: ExamCollectionRepository
  questions: QuestionBankRepository
  cardStates: FsrsCardStateRepository
  reviewEvents: ReviewEventRepository
  bookmarks?: StudyBookmarkRepository
}

export function createNotionStudyRepositories(
  client: StudyNotionClient = getDefaultStudyNotionClient(),
  config: StudyNotionConfig = getStudyNotionConfig(),
  options?: { useContentCache?: boolean }
): StudyRepositories {
  const useContentCache = options?.useContentCache ?? true
  return {
    users: createNotionStudyUserRepository(client, config.usersDbId),
    exams: createNotionExamCollectionRepository(client, config.examsDbId, { useContentCache }),
    questions: createNotionQuestionBankRepository(client, config.questionsDbId, { useContentCache }),
    cardStates: createNotionFsrsCardStateRepository(client, config.cardStatesDbId),
    reviewEvents: createNotionReviewEventRepository(client, config.reviewEventsDbId),
    ...(config.bookmarksDbId
      ? { bookmarks: createNotionStudyBookmarkRepository(client, config.bookmarksDbId) }
      : {}),
  }
}

export * from './interfaces'
export * from './mappers'
