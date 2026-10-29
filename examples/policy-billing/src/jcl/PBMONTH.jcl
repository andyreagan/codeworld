//PBMONTH  JOB (PB0001),'PB STATEMENTS',CLASS=A,MSGCLASS=X
//*********************************************************************
//* Month-end premium statements: build them from DB2 into a new
//* generation of the statement GDG, then format them for the printer.
//*********************************************************************
//STMT     EXEC PGM=IKJEFT01
//STMTOUT  DD DSN=PROD.PB.STMTS(+1),DISP=(NEW,CATLG,DELETE),
//            SPACE=(CYL,(100,20)),DCB=(RECFM=FBA,LRECL=133)
//SYSTSPRT DD SYSOUT=*
//SYSTSIN  DD *
  DSN SYSTEM(DB2P)
  RUN PROGRAM(PBSTMT) PLAN(PBSTMT)
  END
/*
//*
//* Format for the printer and send to the print vendor's queue.
//PRINT    EXEC PGM=PBPRINT,COND=(0,NE)
//PRTIN    DD DSN=PROD.PB.STMTS(0),DISP=SHR
//PRTOUT   DD DSN=PROD.PB.PRINTQ,DISP=MOD
