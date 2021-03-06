import { Campaign, r } from "src/server/models";
import { cacheableData } from "src/server/models/cacheable_queries";
import db from "src/server/db";
import { JobType } from "src/server/workers";
import config from "src/server/config";
import urlJoin from "url-join";
import moment from "moment";
import { accessRequired } from "./errors";
import { mapFieldsToModel, campaignPhoneNumbersEnabled } from "./lib/utils";
import { getUsers } from "./user";

const CampaignStatus = db.Campaign.Status;

const title = 'lower("campaign"."title")';

async function getOrganization(campaign, loaders) {
  return (
    campaign.organization || loaders.organization.load(campaign.organization_id)
  );
}

export function addCampaignsFilterToQuery(queryParam, campaignsFilter) {
  let query = queryParam;

  if (campaignsFilter) {
    const resultSize = campaignsFilter.listSize ? campaignsFilter.listSize : 0;
    const pageSize = campaignsFilter.pageSize ? campaignsFilter.pageSize : 0;

    if ("status" in campaignsFilter) {
      query = query.where("campaign.status", campaignsFilter.status);
    }

    if ("campaignId" in campaignsFilter) {
      query = query.where(
        "campaign.id",
        parseInt(campaignsFilter.campaignId, 10)
      );
    } else if (
      "campaignIds" in campaignsFilter &&
      campaignsFilter.campaignIds.length > 0
    ) {
      query = query.whereIn("campaign.id", campaignsFilter.campaignIds);
    }

    if ("searchString" in campaignsFilter && campaignsFilter.searchString) {
      const searchStringWithPercents = (
        "%" +
        campaignsFilter.searchString +
        "%"
      ).toLocaleLowerCase();
      query = query.andWhere(
        r.knex.raw(`${title} like ?`, [searchStringWithPercents])
      );
    }

    if (resultSize && !pageSize) {
      query = query.limit(resultSize);
    }
    if (resultSize && pageSize) {
      query = query.limit(resultSize).offSet(pageSize);
    }
  }
  return query;
}

export function buildCampaignQuery(
  queryParam,
  organizationId,
  campaignsFilter,
  addFromClause = true
) {
  let query = queryParam;

  if (addFromClause) {
    query = query.from("campaign");
  }

  query = query.where("campaign.organization_id", organizationId);
  query = addCampaignsFilterToQuery(query, campaignsFilter);

  return query;
}

const id = '"campaign"."id"';
const dueDate = '"campaign"."due_by"';

const asc = column => `${column} ASC`;
const desc = column => `${column} DESC`;

const buildOrderByClause = (query, sortBy) => {
  let fragmentArray = undefined;
  switch (sortBy) {
    case "DUE_DATE_ASC":
      fragmentArray = [asc(dueDate), asc(id)];
      break;
    case "DUE_DATE_DESC":
      fragmentArray = [desc(dueDate), asc(id)];
      break;
    case "TITLE":
      fragmentArray = [title];
      break;
    case "ID_DESC":
      fragmentArray = [desc(id)];
      break;
    case "ID_ASC":
    default:
      fragmentArray = [asc(id)];
      break;
  }
  return query.orderByRaw(fragmentArray.join(", "));
};

const buildSelectClause = sortBy => {
  const campaignStar = '"campaign".*';

  const fragmentArray = [campaignStar];

  if (sortBy === "TITLE") {
    fragmentArray.push(title);
  }

  return r.knex.select(r.knex.raw(fragmentArray.join(", ")));
};

export async function getCampaigns(
  organizationId,
  cursor,
  campaignsFilter,
  sortBy
) {
  let campaignsQuery = buildCampaignQuery(
    buildSelectClause(sortBy),
    organizationId,
    campaignsFilter
  );
  campaignsQuery = buildOrderByClause(campaignsQuery, sortBy);

  if (cursor) {
    campaignsQuery = campaignsQuery.limit(cursor.limit).offset(cursor.offset);
    const campaigns = await campaignsQuery;

    const campaignsCountQuery = buildCampaignQuery(
      r.knex.count("*"),
      organizationId,
      campaignsFilter
    );

    const campaignsCountArray = await campaignsCountQuery;

    const pageInfo = {
      limit: cursor.limit,
      offset: cursor.offset,
      total: campaignsCountArray[0].count
    };
    return {
      campaigns,
      pageInfo
    };
  } else {
    return campaignsQuery;
  }
}

export const resolvers = {
  // TODO: optimize campaign stats resolver
  CampaignStats: {
    sentMessagesCount: async (campaign, _, { user }) => {
      await accessRequired(
        user,
        campaign.organization_id,
        "SUPERVOLUNTEER",
        true
      );
      return r
        .table("assignment")
        .getAll(campaign.id, { index: "campaign_id" })
        .eqJoin("id", r.table("message"), { index: "assignment_id" })
        .filter({ is_from_contact: false })
        .count();
    },
    receivedMessagesCount: async (campaign, _, { user }) => {
      await accessRequired(
        user,
        campaign.organization_id,
        "SUPERVOLUNTEER",
        true
      );
      return (
        r
          .table("assignment")
          .getAll(campaign.id, { index: "campaign_id" })
          // TODO: NEEDSTESTING -- see above setMessagesCount()
          .eqJoin("id", r.table("message"), { index: "assignment_id" })
          .filter({ is_from_contact: true })
          .count()
      );
    },
    optOutsCount: async (campaign, _, { user }) => {
      await accessRequired(
        user,
        campaign.organization_id,
        "SUPERVOLUNTEER",
        true
      );
      return await r.getCount(
        r
          .knex("campaign_contact")
          .where({ is_opted_out: true, campaign_id: campaign.id })
      );
    }
  },
  CampaignsReturn: {
    __resolveType(obj, context, _) {
      if (Array.isArray(obj)) {
        return "CampaignsList";
      } else if ("campaigns" in obj && "pageInfo" in obj) {
        return "PaginatedCampaigns";
      }
      return null;
    }
  },
  CampaignsList: {
    campaigns: campaigns => {
      return campaigns;
    }
  },
  PaginatedCampaigns: {
    campaigns: queryResult => {
      return queryResult.campaigns;
    },
    pageInfo: queryResult => {
      if ("pageInfo" in queryResult) {
        return queryResult.pageInfo;
      }
      return null;
    }
  },
  Campaign: {
    ...mapFieldsToModel(
      [
        "id",
        "title",
        "description",
        "isStarted",
        "isArchived",
        "useDynamicAssignment",
        "introHtml",
        "primaryColor",
        "logoImageUrl",
        "overrideOrganizationTextingHours",
        "textingHoursEnforced",
        "textingHoursStart",
        "textingHoursEnd",
        "timezone",
        "shiftingConfiguration",
        "contactFileName"
      ],
      Campaign
    ),
    dueBy: campaign =>
      campaign.due_by instanceof Date || !campaign.due_by
        ? campaign.due_by || null
        : new Date(campaign.due_by),
    startedAt: campaign => {
      const startedAtFallback = campaign.started_at || campaign.created_at;
      return startedAtFallback instanceof Date || !startedAtFallback
        ? startedAtFallback || null
        : new Date(startedAtFallback);
    },
    organization: async (campaign, _, { loaders }) =>
      getOrganization(campaign, loaders),
    datawarehouseAvailable: (campaign, _, { user }) =>
      user.is_superadmin && !!process.env.WAREHOUSE_DB_HOST,
    texters: async (campaign, _, { user }) => {
      await accessRequired(
        user,
        campaign.organization_id,
        "SUPERVOLUNTEER",
        true
      );
      return getUsers(campaign.organization_id, null, {
        campaignId: campaign.id
      });
    },
    assignments: async (campaign, { assignmentsFilter }, { user }) => {
      await accessRequired(
        user,
        campaign.organization_id,
        "SUPERVOLUNTEER",
        true
      );
      let query = r
        .table("assignment")
        .getAll(campaign.id, { index: "campaign_id" });

      if (
        assignmentsFilter &&
        assignmentsFilter.hasOwnProperty("texterId") &&
        assignmentsFilter.textId !== null
      ) {
        query = query.filter({ user_id: assignmentsFilter.texterId });
      }

      return query;
    },
    interactionSteps: async (campaign, _, { user }) => {
      await accessRequired(user, campaign.organization_id, "TEXTER", true);
      return (
        campaign.interactionSteps ||
        cacheableData.campaign.dbInteractionSteps(campaign.id)
      );
    },
    cannedResponses: async (campaign, { userId }, { user }) => {
      await accessRequired(user, campaign.organization_id, "TEXTER", true);
      return await cacheableData.cannedResponse.query({
        userId: userId || "",
        campaignId: campaign.id
      });
    },
    contacts: async (campaign, _, { user }) => {
      await accessRequired(user, campaign.organization_id, "ADMIN", true);
      // TODO: should we include a limit() since this is only for send-replies
      return r.knex("campaign_contact").where({ campaign_id: campaign.id });
    },
    contactsPreview: async (campaign, _, { user }) => {
      await accessRequired(user, campaign.organization_id, "ADMIN", true);
      return r
        .knex("campaign_contact")
        .where({ campaign_id: campaign.id })
        .limit(3);
    },
    contactsCount: async (campaign, _, { user }) => {
      await accessRequired(
        user,
        campaign.organization_id,
        "SUPERVOLUNTEER",
        true
      );
      return await r.getCount(
        r.knex("campaign_contact").where({ campaign_id: campaign.id })
      );
    },
    hasUnassignedContactsForTexter: async (campaign, _, { user }) => {
      // This is the same as hasUnassignedContacts, but the access control
      // is different because for TEXTERs it's just for dynamic campaigns
      // but hasUnassignedContacts for admins is for the campaigns list
      await accessRequired(user, campaign.organization_id, "TEXTER", true);
      if (!campaign.use_dynamic_assignment || campaign.is_archived) {
        return false;
      }
      const contacts = await r
        .knex("campaign_contact")
        .select(r.knex.raw("1"))
        .where({ campaign_id: campaign.id, assignment_id: null })
        .limit(1);
      return contacts.length > 0;
    },
    hasUnassignedContacts: async (campaign, _, { user }) => {
      await accessRequired(
        user,
        campaign.organization_id,
        "SUPERVOLUNTEER",
        true
      );
      const contacts = await r
        .knex("campaign_contact")
        .select("id")
        .where({ campaign_id: campaign.id, assignment_id: null })
        .limit(1);
      return contacts.length > 0;
    },
    hasUnsentInitialMessages: async (campaign, _, { user }) => {
      await accessRequired(
        user,
        campaign.organization_id,
        "SUPERVOLUNTEER",
        true
      );
      const contacts = await r
        .knex("campaign_contact")
        .select("id")
        .where({
          campaign_id: campaign.id,
          message_status: "needsMessage",
          is_opted_out: false
        })
        .limit(1);
      return contacts.length > 0;
    },
    customFields: async campaign =>
      campaign.customFields ||
      cacheableData.campaign.dbCustomFields(campaign.id),
    stats: async campaign => campaign,
    editors: async (campaign, _, { user }) => {
      await accessRequired(
        user,
        campaign.organization_id,
        "SUPERVOLUNTEER",
        true
      );
      if (r.redis) {
        return cacheableData.campaign.currentEditors(campaign, user);
      }
      return "";
    },
    creator: async (campaign, _, { loaders }) =>
      campaign.creator_id ? loaders.user.load(campaign.creator_id) : null,
    phoneNumbers: async (campaign, _, { loaders }) => {
      const org = await getOrganization(campaign, loaders);
      if (!campaignPhoneNumbersEnabled(org)) {
        return null;
      }

      return await db.TwilioPhoneNumber.countByAreaCode({
        campaignId: campaign.id
      });
    },
    joinUrl: async (campaign, _, { user }) => {
      await accessRequired(
        user,
        campaign.organization_id,
        "SUPERVOLUNTEER",
        true
      );
      if (campaign.join_token) {
        return urlJoin(config.BASE_URL, "join-campaign", campaign.join_token);
      }
      return null;
    },
    contactImportJob: async campaign =>
      campaign.contactImportJob ||
      (await db.BackgroundJob.getByTypeAndCampaign(
        JobType.UPLOAD_CONTACTS,
        campaign.id
      )) ||
      null,
    startJob: async campaign =>
      campaign.startJob ||
      (await db.BackgroundJob.getByTypeAndCampaign(
        JobType.START_CAMPAIGN,
        campaign.id
      )) ||
      null,
    status: campaign => {
      // TODO[matteo]: follow up with commit to remove these legacy fields
      const status = campaign.status;
      if (!campaign.is_started || status === CampaignStatus.NOT_STARTED) {
        return CampaignStatus.NOT_STARTED;
      }
      if (campaign.is_archived || status === CampaignStatus.ARCHIVED) {
        return CampaignStatus.ARCHIVED;
      }
      if (status === CampaignStatus.CLOSED) {
        return CampaignStatus.CLOSED;
      }
      // Overdue, closed for initial sends
      if (
        moment
          .utc()
          .startOf("day")
          .isAfter(moment(campaign.due_by))
      ) {
        return CampaignStatus.CLOSED_FOR_INITIAL_SENDS;
      }
      return campaign.status || "ACTIVE";
    },
    assignmentSummaries: async (campaign, _, { user }) => {
      await accessRequired(
        user,
        campaign.organization_id,
        "SUPERVOLUNTEER",
        true
      );

      return await db.Campaign.assignmentSummaries(campaign.id);
    }
  }
};
