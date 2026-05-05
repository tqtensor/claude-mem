
import { BaseSearchStrategy, SearchStrategy } from './SearchStrategy.js';
import {
  StrategySearchOptions,
  StrategySearchResult,
  SEARCH_CONSTANTS,
  ObservationSearchResult,
  SessionSummarySearchResult,
  UserPromptSearchResult
} from '../types.js';
import { SessionSearch } from '../../../sqlite/SessionSearch.js';
import { logger } from '../../../../utils/logger.js';

export class SQLiteSearchStrategy extends BaseSearchStrategy implements SearchStrategy {
  readonly name = 'sqlite';

  constructor(private sessionSearch: SessionSearch) {
    super();
  }

  canHandle(options: StrategySearchOptions): boolean {
    return !options.query || options.strategyHint === 'sqlite';
  }

  async search(options: StrategySearchOptions): Promise<StrategySearchResult> {
    const {
      searchType = 'all',
      obsType,
      concepts,
      files,
      limit = SEARCH_CONSTANTS.DEFAULT_LIMIT,
      offset = 0,
      project,
      dateRange,
      orderBy = 'date_desc'
    } = options;

    const searchObservations = searchType === 'all' || searchType === 'observations';
    const searchSessions = searchType === 'all' || searchType === 'sessions';
    const searchPrompts = searchType === 'all' || searchType === 'prompts';

    let observations: ObservationSearchResult[] = [];
    let sessions: SessionSummarySearchResult[] = [];
    let prompts: UserPromptSearchResult[] = [];

    const baseOptions = { limit, offset, orderBy, project, dateRange };

    logger.debug('SEARCH', 'SQLiteSearchStrategy: Filter-only query', {
      searchType,
      hasDateRange: !!dateRange,
      hasProject: !!project
    });

    const obsOptions = searchObservations ? { ...baseOptions, type: obsType, concepts, files } : null;

    try {
      return await this.executeSqliteSearch(obsOptions, searchSessions, searchPrompts, baseOptions);
    } catch (error) {
      const errorObj = error instanceof Error ? error : new Error(String(error));
      logger.error('WORKER', 'SQLiteSearchStrategy: Search failed', {}, errorObj);
      return this.emptyResult('sqlite');
    }
  }

  private async executeSqliteSearch(
    obsOptions: Record<string, any> | null,
    searchSessions: boolean,
    searchPrompts: boolean,
    baseOptions: Record<string, any>
  ): Promise<StrategySearchResult> {
    let observations: ObservationSearchResult[] = [];
    let sessions: SessionSummarySearchResult[] = [];
    let prompts: UserPromptSearchResult[] = [];

    if (obsOptions) {
      observations = await this.sessionSearch.searchObservations(undefined, obsOptions);
    }
    if (searchSessions) {
      sessions = await this.sessionSearch.searchSessions(undefined, baseOptions);
    }
    if (searchPrompts) {
      prompts = await this.sessionSearch.searchUserPrompts(undefined, baseOptions);
    }

    return {
      results: { observations, sessions, prompts },
      usedChroma: false,
      strategy: 'sqlite'
    };
  }

  async findByConcept(concept: string, options: StrategySearchOptions): Promise<ObservationSearchResult[]> {
    const { limit = SEARCH_CONSTANTS.DEFAULT_LIMIT, project, dateRange, orderBy = 'date_desc' } = options;
    return await this.sessionSearch.findByConcept(concept, { limit, project, dateRange, orderBy });
  }

  async findByType(type: string | string[], options: StrategySearchOptions): Promise<ObservationSearchResult[]> {
    const { limit = SEARCH_CONSTANTS.DEFAULT_LIMIT, project, dateRange, orderBy = 'date_desc' } = options;
    return await this.sessionSearch.findByType(type as any, { limit, project, dateRange, orderBy });
  }

  async findByFile(filePath: string, options: StrategySearchOptions): Promise<{
    observations: ObservationSearchResult[];
    sessions: SessionSummarySearchResult[];
  }> {
    const { limit = SEARCH_CONSTANTS.DEFAULT_LIMIT, project, dateRange, orderBy = 'date_desc' } = options;
    return await this.sessionSearch.findByFile(filePath, { limit, project, dateRange, orderBy });
  }
}
