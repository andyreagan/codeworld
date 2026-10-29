//PBNIGHT  JOB (PB0001),'POLICY BILLING',CLASS=A,MSGCLASS=X,
//             NOTIFY=&SYSUID
//*********************************************************************
//* Nightly premium billing: sort the day's premium transactions,
//* extract and price them, post them to DB2, and print the run report.
//*********************************************************************
//         SET HLQ=PROD
//JOBLIB   DD DSN=PROD.PB.LOADLIB,DISP=SHR
//*
//* Clear yesterday's extract so the PROC can catalog a new one.
//STEP010  EXEC PGM=IEFBR14
//DD1      DD DSN=&HLQ..PB.EXTRACT,DISP=(MOD,DELETE,DELETE),
//            SPACE=(TRK,0)
//*
//* Sort the day's transactions by policy number.
//STEP020  EXEC PGM=SORT
//SORTIN   DD DSN=&HLQ..PB.PREMTXN.DAILY,DISP=SHR
//SORTOUT  DD DSN=&&SORTED,DISP=(NEW,PASS),
//            SPACE=(CYL,(50,10)),UNIT=SYSDA
//SYSIN    DD *
  SORT FIELDS=(1,10,CH,A)
/*
//SYSOUT   DD SYSOUT=*
//*
//* Extract and price (cataloged PROC, shared with the re-run job).
//STEP030  EXEC PBEXTPRC,HLQ=&HLQ,RUNDT=TODAY
//EXTRACT.SYSOUT DD SYSOUT=*
//*
//* Post to DB2 under TSO batch.
//STEP040  EXEC PGM=IKJEFT01,COND=(4,LT)
//EXTIN    DD DSN=&HLQ..PB.EXTRACT,DISP=SHR
//POSTOUT  DD DSN=&HLQ..PB.POSTED,DISP=(NEW,CATLG,DELETE),
//            SPACE=(CYL,(20,5))
//SYSTSPRT DD SYSOUT=*
//SYSTSIN  DD *
  DSN SYSTEM(DB2P)
  RUN PROGRAM(PBPOST) PLAN(PBPOST) LIB('PROD.PB.LOADLIB')
  END
/*
//*
//* Run report (Easytrieve Plus).
//STEP050  EXEC PGM=EZTPA00,COND=(4,LT)
//POSTED   DD DSN=&HLQ..PB.POSTED,DISP=SHR
//SYSIN    DD DSN=PROD.PB.EZTLIB(PBRPT),DISP=SHR
//SYSPRINT DD SYSOUT=*
